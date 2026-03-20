(function(){

if(window.OverlayBus) return;

const listeners = {};

function on(event, handler){

    if(!listeners[event]) listeners[event] = [];

    listeners[event].push(handler);

}

function emit(event, payload){

    if(!listeners[event]) return;

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

})();