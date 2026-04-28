(function() {
    if (window.OverlayBridge) return;

    let commandChannel = null;
    const BRIDGE_ID = Math.random().toString(36).slice(2);
    const recentCommands = new Map();
    const DEDUPE_MS = 150;
    let wired = false;
    let lastCommandTime = 0;

    function makeDedupeKey(payload) {
        // Excluir solo campos volátiles (timestamp, _ts, _source)
        // SIN eliminar cmd ni command, para diferenciar comandos distintos
        const { timestamp, _ts, _source, ...stable } = payload;
        return JSON.stringify(stable);
    }

    function isDuplicate(key) {
        const expiry = recentCommands.get(key);
        if (expiry && Date.now() < expiry) return true;
        recentCommands.set(key, Date.now() + DEDUPE_MS);
        if (recentCommands.size > 50) {
            const now = Date.now();
            recentCommands.forEach((exp, k) => {
                if (exp < now) recentCommands.delete(k);
            });
        }
        return false;
    }

    try {
        commandChannel = new BroadcastChannel("pubgm_commands");
        console.log("[OverlayBridge] BroadcastChannel iniciado, id=" + BRIDGE_ID);
    } catch (e) {
        console.warn("[OverlayBridge] BroadcastChannel no disponible", e);
    }

    function processCommand(payload, shouldBroadcast = false) {
        if (!payload || typeof payload !== 'object') return;

        // Normalizar comando: acepta tanto 'command' como 'cmd'
        const cmd = payload.command || payload.cmd;
        if (!cmd || typeof cmd !== 'string' || cmd.trim() === '') return;
        payload.command = cmd;

        // Protección contra flood: máximo un comando cada 30ms
        const now = Date.now();
        if (now - lastCommandTime < 30) return;
        lastCommandTime = now;

        // Evitar procesar el mismo payload múltiples veces (rebroadcast)
        if (payload._processedByBridge) return;
        payload._processedByBridge = true;

        const key = makeDedupeKey(payload);
        if (isDuplicate(key)) {
            console.log(`[OverlayBridge] duplicado ignorado: ${payload.command}`);
            return;
        }

        if (window.OverlayBus) {
            OverlayBus.emit(payload.command, payload);
            console.log(`[OverlayBridge] comando emitido en bus: ${payload.command}`);
        } else {
            console.warn("[OverlayBridge] OverlayBus no disponible");
        }

        if (shouldBroadcast && commandChannel) {
            commandChannel.postMessage({
                type: 'command',
                _bridgeId: BRIDGE_ID,
                ...payload,          // preserva todos los datos semánticos
                timestamp: Date.now()
            });
            console.log(`[OverlayBridge] comando broadcast: ${payload.command}`);
        }
    }

    window.addEventListener("storage", function(e) {
        if (e.key !== "overlay_manual_cmd") return;
        if (!e.newValue) return;
        try {
            const payload = JSON.parse(e.newValue);
            processCommand(payload, true);
        } catch (err) {
            console.error("[OverlayBridge] Error parsing storage command", err);
        }
    });

    if (commandChannel) {
        commandChannel.onmessage = function(event) {
            const data = event.data;
            if (!data) return;
            if (data._bridgeId === BRIDGE_ID) return;
            const cmd = data.cmd || data.command;
            if (!cmd) return;
            const payload = { ...data, command: cmd };
            processCommand(payload, false);
        };
    }

    window.addEventListener("beforeunload", function() {
        if (commandChannel) {
            commandChannel.close();
            console.log("[OverlayBridge] canal cerrado");
        }
    });

    function wireCommandToConfig() {
        if (wired) return;

        if (!window.OverlayBus || !window.OverlayConfig) {
            setTimeout(wireCommandToConfig, 50);
            return;
        }

        wired = true;

        OverlayBus.on("set_display_mode", function(payload) {
            if (!payload) return;
            const mode = payload.mode === "individual" ? "individual" : "team";
            const current = OverlayConfig.get()?.display?.displayMode;
            if (current === mode) return;
            OverlayConfig.set({ display: { displayMode: mode } });
            console.log("[OverlayBridge] display_mode →", mode);
        });

        OverlayBus.on("display_mode_individual", function() {
            if (OverlayConfig.get()?.display?.displayMode === "individual") return;
            OverlayConfig.set({ display: { displayMode: "individual" } });
        });

        OverlayBus.on("display_mode_team", function() {
            if (OverlayConfig.get()?.display?.displayMode === "team") return;
            OverlayConfig.set({ display: { displayMode: "team" } });
        });

        OverlayBus.on("alert_firstKill_on", () => OverlayConfig.set({ alerts: { firstKill: true } }));
        OverlayBus.on("alert_firstKill_off", () => OverlayConfig.set({ alerts: { firstKill: false } }));
        OverlayBus.on("alert_firstGrenade_on", () => OverlayConfig.set({ alerts: { firstGrenade: true } }));
        OverlayBus.on("alert_firstGrenade_off", () => OverlayConfig.set({ alerts: { firstGrenade: false } }));
        OverlayBus.on("alert_teamEliminated_on", () => OverlayConfig.set({ alerts: { teamEliminated: true } }));
        OverlayBus.on("alert_teamEliminated_off", () => OverlayConfig.set({ alerts: { teamEliminated: false } }));
        OverlayBus.on("alert_zone_on", () => OverlayConfig.set({ alerts: { zone: true } }));
        OverlayBus.on("alert_zone_off", () => OverlayConfig.set({ alerts: { zone: false } }));

        OverlayBus.on("ui_dropsRoutes_on", () => OverlayConfig.set({ ui: { showDropsRoutes: true } }));
        OverlayBus.on("ui_dropsRoutes_off", () => OverlayConfig.set({ ui: { showDropsRoutes: false } }));
        OverlayBus.on("ui_throwables_on", () => OverlayConfig.set({ ui: { showThrowables: true } }));
        OverlayBus.on("ui_throwables_off", () => OverlayConfig.set({ ui: { showThrowables: false } }));
        OverlayBus.on("ui_teamTable_on", () => OverlayConfig.set({ ui: { showTeamTable: true } }));
        OverlayBus.on("ui_teamTable_off", () => OverlayConfig.set({ ui: { showTeamTable: false } }));

        OverlayBus.on("col_pp_on", () => OverlayConfig.set({ columns: { showPP: true } }));
        OverlayBus.on("col_pp_off", () => OverlayConfig.set({ columns: { showPP: false } }));
        OverlayBus.on("col_total_on", () => OverlayConfig.set({ columns: { showTotal: true } }));
        OverlayBus.on("col_total_off", () => OverlayConfig.set({ columns: { showTotal: false } }));

        OverlayBus.on("set_scoring", function(payload) {
            if (!payload) return;
            const patch = {};
            if (payload.pp !== undefined) patch.pp = payload.pp;
            if (payload.pePerKill !== undefined) patch.pePerKill = Number(payload.pePerKill);
            if (payload.bonusEnabled !== undefined) patch.bonusEnabled = !!payload.bonusEnabled;
            if (payload.bonus !== undefined) patch.bonus = payload.bonus;
            OverlayConfig.set({ scoring: patch });
            console.log("[OverlayBridge] set_scoring →", patch);
        });

        console.log("[OverlayBridge] comando→config listeners activos");
    }

    wireCommandToConfig();

    window.OverlayBridge = {
        dispatch: function(payload) {
            processCommand(payload, true);
        }
    };

    console.log("[OverlayBridge] inicializado");
})();
