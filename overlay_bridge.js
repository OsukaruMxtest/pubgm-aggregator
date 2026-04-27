(function() {
    if (window.OverlayBridge) return;

    let commandChannel = null;
    let internalDispatch = false;

    let lastCommand = null;
    let lastTimestamp = 0;

    try {
        commandChannel = new BroadcastChannel("pubgm_commands");
        console.log("[OverlayBridge] BroadcastChannel iniciado");
    } catch (e) {
        console.warn("[OverlayBridge] BroadcastChannel no disponible", e);
    }

    function processCommand(payload, shouldBroadcast = false) {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        if (typeof payload.command !== 'string' || payload.command.trim() === '') {
            return;
        }

        const now = Date.now();
        if (payload.command === lastCommand && now - lastTimestamp < 100) {
            console.log(`[OverlayBridge] comando duplicado ignorado: ${payload.command}`);
            return;
        }
        lastCommand = payload.command;
        lastTimestamp = now;

        if (internalDispatch) {
            console.log("[OverlayBridge] loop evitado");
            return;
        }

        internalDispatch = true;

        try {
            if (window.OverlayBus) {
                OverlayBus.emit(payload.command, payload);
                console.log(`[OverlayBridge] comando emitido en bus: ${payload.command}`);
            } else {
                console.warn("[OverlayBridge] OverlayBus no disponible");
            }

            if (shouldBroadcast && commandChannel) {
                commandChannel.postMessage({
                    type: 'command',
                    cmd: payload.command,
                    timestamp: Date.now()
                });
                console.log(`[OverlayBridge] comando broadcast: ${payload.command}`);
            }
        } finally {
            setTimeout(() => {
                internalDispatch = false;
            }, 0);
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
        if (!window.OverlayBus || !window.OverlayConfig) {
            setTimeout(wireCommandToConfig, 50);
            return;
        }

        OverlayBus.on("set_display_mode", function(payload) {
            const mode = payload && payload.mode === "individual" ? "individual" : "team";
            OverlayConfig.set({ display: { displayMode: mode } });
            console.log("[OverlayBridge] display_mode →", mode);
        });

        OverlayBus.on("display_mode_individual", function() {
            OverlayConfig.set({ display: { displayMode: "individual" } });
        });
        OverlayBus.on("display_mode_team", function() {
            OverlayConfig.set({ display: { displayMode: "team" } });
        });

        OverlayBus.on("alert_firstKill_on",         function() { OverlayConfig.set({ alerts: { firstKill: true } }); });
        OverlayBus.on("alert_firstKill_off",        function() { OverlayConfig.set({ alerts: { firstKill: false } }); });
        OverlayBus.on("alert_firstGrenade_on",      function() { OverlayConfig.set({ alerts: { firstGrenade: true } }); });
        OverlayBus.on("alert_firstGrenade_off",     function() { OverlayConfig.set({ alerts: { firstGrenade: false } }); });
        OverlayBus.on("alert_teamEliminated_on",    function() { OverlayConfig.set({ alerts: { teamEliminated: true } }); });
        OverlayBus.on("alert_teamEliminated_off",   function() { OverlayConfig.set({ alerts: { teamEliminated: false } }); });
        OverlayBus.on("alert_zone_on",              function() { OverlayConfig.set({ alerts: { zone: true } }); });
        OverlayBus.on("alert_zone_off",             function() { OverlayConfig.set({ alerts: { zone: false } }); });

        OverlayBus.on("ui_dropsRoutes_on",  function() { OverlayConfig.set({ ui: { showDropsRoutes: true } }); });
        OverlayBus.on("ui_dropsRoutes_off", function() { OverlayConfig.set({ ui: { showDropsRoutes: false } }); });
        OverlayBus.on("ui_throwables_on",   function() { OverlayConfig.set({ ui: { showThrowables: true } }); });
        OverlayBus.on("ui_throwables_off",  function() { OverlayConfig.set({ ui: { showThrowables: false } }); });
        OverlayBus.on("ui_teamTable_on",    function() { OverlayConfig.set({ ui: { showTeamTable: true } }); });
        OverlayBus.on("ui_teamTable_off",   function() { OverlayConfig.set({ ui: { showTeamTable: false } }); });

        OverlayBus.on("col_pp_on",    function() { OverlayConfig.set({ columns: { showPP: true } }); });
        OverlayBus.on("col_pp_off",   function() { OverlayConfig.set({ columns: { showPP: false } }); });
        OverlayBus.on("col_total_on", function() { OverlayConfig.set({ columns: { showTotal: true } }); });
        OverlayBus.on("col_total_off",function() { OverlayConfig.set({ columns: { showTotal: false } }); });

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
