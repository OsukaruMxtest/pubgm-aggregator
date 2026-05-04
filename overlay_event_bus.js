(function(){

if(window.OverlayBus) return;

const listeners = {};

// ─── Guard de deduplicación ───────────────────────────────────────────────────
// Evita que el mismo evento con el mismo payload se procese más de una vez
// consecutiva. Previene múltiples set() / notify() / renders por emit redundante.
const _lastEventState = {};

function on(event, handler){

    if(!listeners[event]) listeners[event] = [];

    if(listeners[event].includes(handler)) return;
    listeners[event].push(handler);

}

function emit(event, payload){

    if(!listeners[event]) return;

    const key = JSON.stringify(payload ?? "__no_payload__");
    if(_lastEventState[event] === key) return;
    _lastEventState[event] = key;

    listeners[event].forEach(fn=>{
        try{ fn(payload); }catch(e){}
    });

}

function off(event, handler){

    if(!listeners[event]) return;

    listeners[event] =
        listeners[event].filter(h=>h !== handler);

}

window.OverlayBus = {
    on,
    emit,
    off
};

// ─── Evento unificado config:update → OverlayConfig ──────────────────────────
// Reemplaza eventos granulares (col_pp_on/off, etc.) con un único evento de
// estado. Escala a cualquier sección del config sin agregar más eventos.
//
//   Uso:  OverlayBus.emit("config:update", { columns: { pp: true } })
//         OverlayBus.emit("config:update", { utilities: { show: false } })

window.OverlayBus.on("config:update", function(patch){
    if(!patch || typeof patch !== "object") return;
    window.OverlayConfig?.set(patch);
});

// ─── Eventos granulares legacy (compatibilidad hacia atrás) ───────────────────
// Se mantienen para no romper overlays existentes que ya emiten estos eventos.
// Internamente delegan a config:update para no duplicar lógica de persistencia.

window.OverlayBus.on("col_pp_on",     function(){ window.OverlayBus.emit("config:update", { columns:{ pp:true    } }); });
window.OverlayBus.on("col_pp_off",    function(){ window.OverlayBus.emit("config:update", { columns:{ pp:false   } }); });
window.OverlayBus.on("col_total_on",  function(){ window.OverlayBus.emit("config:update", { columns:{ total:true  } }); });
window.OverlayBus.on("col_total_off", function(){ window.OverlayBus.emit("config:update", { columns:{ total:false } }); });

window.OverlayBus.on("utilities_on",  function(){ window.OverlayBus.emit("config:update", { utilities:{ show:true  } }); });
window.OverlayBus.on("utilities_off", function(){ window.OverlayBus.emit("config:update", { utilities:{ show:false } }); });

// ─── Sync bidireccional: Config → Bus ────────────────────────────────────────
// Cuando OverlayConfig cambia desde cualquier origen (BroadcastChannel,
// localStorage, otro overlay), el bus emite "config:changed" para que
// cualquier overlay suscrito al bus pueda reaccionar sin depender de
// OverlayConfig.subscribe() directamente.
//
// IMPORTANTE: config:changed es de solo lectura.
// Los handlers NO deben emitir config:update en respuesta — generaría un loop.
//
// attachConfigSync() reintenta cada 50ms hasta encontrar OverlayConfig,
// cubriendo casos donde overlay_config.js carga después que este archivo.

function attachConfigSync(){
    if(!window.OverlayConfig) return false;
    window.OverlayConfig.subscribe(function(cfg){
        emit("config:changed", cfg);
    });
    return true;
}

if(!attachConfigSync()){
    let _retrySyncAttempts = 0;
    const _retrySync = setInterval(function(){
        if(attachConfigSync() || _retrySyncAttempts++ > 100){
            clearInterval(_retrySync);
        }
    }, 50);
}

})();