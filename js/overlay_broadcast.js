/*
 * overlay_broadcast.js
 * Broadcast Overlay Architecture for PUBG Mobile Esports
 * Production-grade module for synchronizing multiple OBS Browser Sources
 * via BroadcastChannel.
 *
 * This module centralizes snapshot and command distribution,
 * eliminates redundant polling, and ensures resilience for long streams.
 *
 * (c) 2025 PUBG Mobile Esports Engineering
 */

(function(global) {
    'use strict';

    /**
     * Unique identifier for this overlay instance.
     * Used to ignore self-sent messages and prevent echo loops.
     */
    const SENDER_ID = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

    /**
     * Debug flag – set to true in development for detailed logs.
     */
    const DEBUG = typeof window !== 'undefined' && window.DEBUG_OVERLAY === true;

    /**
     * Core module state.
     * @private
     */
    const _state = {
        currentSnapshot: null,                // last valid snapshot (any format)
        lastSnapshotKey: null,                 // unique key of last processed snapshot (to avoid duplicates)
        lastCommandTimestamp: 0,                // timestamp of last processed command
        snapshotCallbacks: [],                  // array of snapshot subscriber functions
        commandCallbacks: [],                    // array of command subscriber functions
        heartbeatCallbacks: [],                  // optional heartbeat subscribers
        heartbeatIntervalId: null,               // interval ID for leader heartbeat
        isInitialized: false,                     // guard against multiple init
        channels: {
            snapshot: null,
            commands: null,
            heartbeat: null
        }
    };

    /**
     * Safely log errors without disrupting OBS.
     * Only logs if DEBUG is true.
     * @private
     * @param {*} err 
     */
    function _logError(err) {
        if (DEBUG && typeof console !== 'undefined' && console.error) {
            console.error('[OverlayBroadcast]', err);
        }
    }

    /**
     * Generate a unique key for a snapshot without heavy stringification.
     * Uses snapshot.CurrentTime if available, otherwise GameID + player count.
     * @private
     * @param {*} snapshot 
     * @returns {string|null}
     */
    function _getSnapshotKey(snapshot) {
        if (!snapshot) return null;

        // Common PUBG snapshot structures: sometimes allinfo contains the actual data
        const allinfo = snapshot.allinfo || snapshot;

        // If CurrentTime exists, it's the most reliable unique timestamp
        if (allinfo.CurrentTime !== undefined) {
            return `t:${allinfo.CurrentTime}`;
        }

        // If GameID and player list exist, combine them for a reasonable unique key
        if (allinfo.GameID && Array.isArray(allinfo.TotalPlayerList)) {
            return `g:${allinfo.GameID}:p:${allinfo.TotalPlayerList.length}`;
        }

        // Fallback to a timestamp (still cheaper than JSON.stringify)
        return `fallback:${Date.now()}`;
    }

    /**
     * Initialize BroadcastChannels and set up message listeners.
     * Called automatically when script loads, but can be called manually to reinitialize.
     * @public
     */
    function init() {
        if (_state.isInitialized) {
            _logError('OverlayBroadcast already initialized. Call destroy() first if you need to reinitialize.');
            return;
        }

        // Try to create BroadcastChannels, falling back gracefully if not supported
        try {
            _state.channels.snapshot = new BroadcastChannel('pubgm_snapshot');
        } catch (err) {
            _logError('Snapshot BroadcastChannel not supported: ' + err.message);
        }

        try {
            _state.channels.commands = new BroadcastChannel('pubgm_commands');
        } catch (err) {
            _logError('Commands BroadcastChannel not supported: ' + err.message);
        }

        try {
            _state.channels.heartbeat = new BroadcastChannel('pubgm_heartbeat');
        } catch (err) {
            _logError('Heartbeat BroadcastChannel not supported: ' + err.message);
        }

        // Set up message handlers if channels exist
        if (_state.channels.snapshot) {
            _state.channels.snapshot.onmessage = function(event) {
                _handleSnapshotMessage(event.data);
            };
        }

        if (_state.channels.commands) {
            _state.channels.commands.onmessage = function(event) {
                _handleCommandMessage(event.data);
            };
        }

        if (_state.channels.heartbeat) {
            _state.channels.heartbeat.onmessage = function(event) {
                _handleHeartbeatMessage(event.data);
            };
        }

        _state.isInitialized = true;

        // Register cleanup on page unload (prevents memory leaks in long streams)
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', destroy);
        }
    }

    /**
     * Clean up resources: close channels, clear intervals, remove listeners.
     * @public
     */
    function destroy() {
        if (_state.heartbeatIntervalId) {
            clearInterval(_state.heartbeatIntervalId);
            _state.heartbeatIntervalId = null;
        }

        // Close all channels
        Object.keys(_state.channels).forEach(key => {
            const ch = _state.channels[key];
            if (ch && typeof ch.close === 'function') {
                try {
                    ch.close();
                } catch (e) {
                    // ignore
                }
            }
            _state.channels[key] = null;
        });

        // Remove beforeunload listener
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', destroy);
        }

        // Reset state
        _state.snapshotCallbacks = [];
        _state.commandCallbacks = [];
        _state.heartbeatCallbacks = [];
        _state.currentSnapshot = null;
        _state.lastSnapshotKey = null;
        _state.lastCommandTimestamp = 0;
        _state.isInitialized = false;
    }

    /**
     * Handle incoming snapshot messages.
     * @private
     * @param {*} message 
     */
    function _handleSnapshotMessage(message) {
        // Ignore messages sent by this instance
        if (message && message.senderId === SENDER_ID) return;

        let snapshotData = null;
        let timestamp = 0;

        // Normalize message format (supports raw snapshot or wrapped object)
        if (message && message.type === 'snapshot' && message.data) {
            // Formato B
            snapshotData = message.data;
            timestamp = message.timestamp || 0;
        } else {
            // Formato A: assume message is the snapshot itself
            snapshotData = message;
            timestamp = (message && message.timestamp) ? message.timestamp : Date.now();
        }

        // Validate snapshotData: must exist and be an object (not a primitive)
        if (!snapshotData || typeof snapshotData !== 'object') return;

        // Generate key for duplicate detection
        const key = _getSnapshotKey(snapshotData);
        if (key && key === _state.lastSnapshotKey) {
            // Duplicate snapshot, ignore
            return;
        }

        // Update state
        _state.lastSnapshotKey = key;
        _state.currentSnapshot = snapshotData;

        // Notify all snapshot subscribers safely
        for (const cb of _state.snapshotCallbacks) {
            try {
                cb(snapshotData);
            } catch (err) {
                _logError('Snapshot callback error: ' + err.message);
            }
        }
    }

    /**
     * Handle incoming command messages.
     * @private
     * @param {*} message 
     */
    function _handleCommandMessage(message) {
        if (!message || message.senderId === SENDER_ID) return;
        if (message.type !== 'command' || !message.cmd) return;

        // Timestamp-based duplicate prevention
        const ts = message.timestamp || 0;
        if (ts <= _state.lastCommandTimestamp) return;

        _state.lastCommandTimestamp = ts;

        // Notify command subscribers safely
        for (const cb of _state.commandCallbacks) {
            try {
                cb(message.cmd, message);
            } catch (err) {
                _logError('Command callback error: ' + err.message);
            }
        }
    }

    /**
     * Handle incoming heartbeat messages.
     * @private
     * @param {*} message 
     */
    function _handleHeartbeatMessage(message) {
        if (!message || message.senderId === SENDER_ID) return;
        if (message.type !== 'heartbeat') return;

        // Notify heartbeat subscribers (if any) safely
        for (const cb of _state.heartbeatCallbacks) {
            try {
                cb(message);
            } catch (err) {
                _logError('Heartbeat callback error: ' + err.message);
            }
        }
    }

    /**
     * Broadcast a snapshot to all overlays.
     * Should be called by the leader overlay (e.g., barras_aniversario.html).
     * @public
     * @param {*} snapshot - The snapshot data (any JSON-serializable format)
     * @returns {boolean} - True if broadcast succeeded, false otherwise
     */
    function broadcastSnapshot(snapshot) {
        if (!snapshot) return false;

        // Validate snapshot (optional, but good practice)
        if (typeof snapshot !== 'object') return false;

        // Prepare wrapped message with type and timestamp
        const message = {
            type: 'snapshot',
            data: snapshot,
            timestamp: Date.now(),
            senderId: SENDER_ID
        };

        // Update local state immediately (leader doesn't need to wait for loopback)
        const key = _getSnapshotKey(snapshot);
        if (key) {
            _state.lastSnapshotKey = key;
        }
        _state.currentSnapshot = snapshot;

        // Send via BroadcastChannel
        if (_state.channels.snapshot) {
            try {
                _state.channels.snapshot.postMessage(message);
                return true;
            } catch (err) {
                _logError('broadcastSnapshot error: ' + err.message);
            }
        }
        return false;
    }

    /**
     * Broadcast a command to all overlays.
     * @public
     * @param {string} cmd - Command string (e.g., 'showFinal', 'hideAll')
     * @returns {boolean} - True if broadcast succeeded
     */
    function broadcastCommand(cmd) {
        if (!cmd || typeof cmd !== 'string') return false;

        const message = {
            type: 'command',
            cmd: cmd,
            timestamp: Date.now(),
            senderId: SENDER_ID
        };

        if (_state.channels.commands) {
            try {
                _state.channels.commands.postMessage(message);
                return true;
            } catch (err) {
                _logError('broadcastCommand error: ' + err.message);
            }
        }
        return false;
    }

    /**
     * Subscribe to snapshot updates.
     * Prevents duplicate callbacks.
     * @public
     * @param {Function} callback - Function that receives the snapshot data.
     * @returns {Function} Unsubscribe function.
     */
    function subscribeSnapshot(callback) {
        if (typeof callback !== 'function') return function() {};

        // Avoid duplicate subscriptions
        if (!_state.snapshotCallbacks.includes(callback)) {
            _state.snapshotCallbacks.push(callback);
        }

        // Immediately deliver current snapshot if available
        if (_state.currentSnapshot) {
            try {
                callback(_state.currentSnapshot);
            } catch (err) {
                _logError('Initial snapshot callback error: ' + err.message);
            }
        }

        // Return unsubscribe function
        return function() {
            const index = _state.snapshotCallbacks.indexOf(callback);
            if (index !== -1) {
                _state.snapshotCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Subscribe to command updates.
     * Prevents duplicate callbacks.
     * @public
     * @param {Function} callback - Function that receives the command string and full message.
     * @returns {Function} Unsubscribe function.
     */
    function subscribeCommand(callback) {
        if (typeof callback !== 'function') return function() {};
        if (!_state.commandCallbacks.includes(callback)) {
            _state.commandCallbacks.push(callback);
        }
        return function() {
            const index = _state.commandCallbacks.indexOf(callback);
            if (index !== -1) {
                _state.commandCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Subscribe to heartbeat messages (optional, for monitoring).
     * Prevents duplicate callbacks.
     * @public
     * @param {Function} callback 
     * @returns {Function} Unsubscribe function.
     */
    function subscribeHeartbeat(callback) {
        if (typeof callback !== 'function') return function() {};
        if (!_state.heartbeatCallbacks.includes(callback)) {
            _state.heartbeatCallbacks.push(callback);
        }
        return function() {
            const index = _state.heartbeatCallbacks.indexOf(callback);
            if (index !== -1) {
                _state.heartbeatCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Get the last valid snapshot stored.
     * @public
     * @returns {*} The last snapshot, or null if none.
     */
    function getCurrentSnapshot() {
        return _state.currentSnapshot;
    }

    /**
     * Start sending heartbeat messages (leader only).
     * @public
     * @param {number} intervalMs - Milliseconds between heartbeats (default 3000).
     * @returns {boolean} True if heartbeat started, false if already running or no channel.
     */
    function startHeartbeat(intervalMs = 3000) {
        if (_state.heartbeatIntervalId) {
            _logError('Heartbeat already running. Call stopHeartbeat() first if you want to restart.');
            return false;
        }
        if (!_state.channels.heartbeat) return false;

        _state.heartbeatIntervalId = setInterval(() => {
            const message = {
                type: 'heartbeat',
                timestamp: Date.now(),
                senderId: SENDER_ID
            };
            try {
                _state.channels.heartbeat.postMessage(message);
            } catch (err) {
                _logError('Heartbeat send error: ' + err.message);
            }
        }, intervalMs);

        return true;
    }

    /**
     * Stop sending heartbeats (leader only).
     * @public
     */
    function stopHeartbeat() {
        if (_state.heartbeatIntervalId) {
            clearInterval(_state.heartbeatIntervalId);
            _state.heartbeatIntervalId = null;
        }
    }

    /**
     * Check if this overlay instance is the leader (by whether it sends heartbeats).
     * @public
     * @returns {boolean}
     */
    function isLeader() {
        return _state.heartbeatIntervalId !== null;
    }

    // Public API
    const OverlayBroadcast = {
        init,
        destroy,
        broadcastSnapshot,
        broadcastCommand,
        subscribeSnapshot,
        subscribeCommand,
        subscribeHeartbeat,
        getCurrentSnapshot,
        startHeartbeat,
        stopHeartbeat,
        isLeader,
        // Expose senderId for debugging
        _senderId: SENDER_ID
    };

    // Auto-initialize when script loads, but defer to ensure all scripts are ready
    if (typeof window !== 'undefined') {
        // Use setTimeout to run after current call stack (defer)
        setTimeout(init, 0);
    } else {
        // Non-browser environment (should not happen, but fallback)
        init();
    }

    // Expose globally
    global.OverlayBroadcast = OverlayBroadcast;

})(typeof window !== 'undefined' ? window : this);