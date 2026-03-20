(function() {
    // Evitar múltiples inicializaciones
    if (window.OverlayBridge) return;

    // Variables internas
    let commandChannel = null;
    let internalDispatch = false;

    // Mejora #1: deduplicación por timestamp
    let lastCommand = null;
    let lastTimestamp = 0;

    // Inicializar BroadcastChannel de forma segura
    try {
        commandChannel = new BroadcastChannel("pubgm_commands");
        console.log("[OverlayBridge] BroadcastChannel iniciado");
    } catch (e) {
        console.warn("[OverlayBridge] BroadcastChannel no disponible", e);
    }

    // Función central para procesar comandos
    function processCommand(payload, shouldBroadcast = false) {
        // Validar payload y comando (Mejora #2: seguridad de payload)
        if (!payload || typeof payload !== 'object') {
            return;
        }
        if (typeof payload.command !== 'string' || payload.command.trim() === '') {
            return;
        }

        // Mejora #1: deduplicación por timestamp (misma ventana de 100ms)
        const now = Date.now();
        if (payload.command === lastCommand && now - lastTimestamp < 100) {
            console.log(`[OverlayBridge] comando duplicado ignorado: ${payload.command}`);
            return;
        }
        lastCommand = payload.command;
        lastTimestamp = now;

        // Evitar loops
        if (internalDispatch) {
            console.log("[OverlayBridge] loop evitado");
            return;
        }

        internalDispatch = true;

        try {
            // Emitir localmente a través de OverlayBus
            if (window.OverlayBus) {
                OverlayBus.emit(payload.command, payload);
                console.log(`[OverlayBridge] comando emitido en bus: ${payload.command}`);
            } else {
                console.warn("[OverlayBridge] OverlayBus no disponible");
            }

            // Retransmitir a otras pestañas/overlays (solo si es comando externo)
            if (shouldBroadcast && commandChannel) {
                commandChannel.postMessage({
                    type: 'command',
                    cmd: payload.command,
                    timestamp: Date.now()
                });
                console.log(`[OverlayBridge] comando broadcast: ${payload.command}`);
            }
        } finally {
            // Liberar flag en el siguiente ciclo para evitar bloqueos permanentes
            setTimeout(() => {
                internalDispatch = false;
            }, 0);
        }
    }

    // Escuchar comandos desde localStorage (overlay_control.html)
    window.addEventListener("storage", function(e) {
        if (e.key !== "overlay_manual_cmd") return;
        if (!e.newValue) return;

        try {
            const payload = JSON.parse(e.newValue);
            processCommand(payload, true); // broadcast = true
        } catch (err) {
            console.error("[OverlayBridge] Error parsing storage command", err);
        }
    });

    // Escuchar comandos desde BroadcastChannel (otros overlays)
    if (commandChannel) {
        commandChannel.onmessage = function(event) {
            const data = event.data;
            if (!data) return;

            // Normalizar: aceptar tanto 'cmd' como 'command'
            const cmd = data.cmd || data.command;
            if (!cmd) return;

            // Crear payload manteniendo todas las propiedades originales
            const payload = { ...data, command: cmd };
            processCommand(payload, false); // broadcast = false (evita eco)
        };
    }

    // Limpiar canal al cerrar (importante para OBS)
    window.addEventListener("beforeunload", function() {
        if (commandChannel) {
            commandChannel.close();
            console.log("[OverlayBridge] canal cerrado");
        }
    });

    // API pública (compatible con versión anterior)
    window.OverlayBridge = {
        dispatch: function(payload) {
            processCommand(payload, true); // broadcast = true
        }
    };

    console.log("[OverlayBridge] inicializado");
})();