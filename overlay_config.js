(function(){

if(window.OverlayConfig) return;

const STORAGE_KEY = "overlayConfig";

let data = {
    alerts:{
        firstKill:true,
        firstGrenade:true,
        teamEliminated:true,
        zone:true
    },
    tables:{
        teamBars:true,
        desafios:true
    },
    animations:{
        enabled:true
    },
    map:{
        enabled:true
    },
    finalScreen:{
        automaticMode:false
    },
    display:{
        displayMode:"team"
    },
    ui:{
        showTeamTable:true,
        showDropsRoutes:false,
        showThrowables:false
    }
};

const listeners = [];

let configChannel = null;
try{
    configChannel = new BroadcastChannel("pubgm_config");
}catch(e){}

function mergeDeep(target, source){

    for(const key in source){

        if(
            typeof source[key] === "object" &&
            source[key] !== null &&
            !Array.isArray(source[key])
        ){

            if(!target[key] || typeof target[key] !== "object"){
                target[key] = {};
            }

            mergeDeep(target[key], source[key]);

        }else{

            target[key] = source[key];

        }

    }

}

function load(){

    try{

        const stored = localStorage.getItem(STORAGE_KEY);

        if(stored){

            const parsed = JSON.parse(stored);

            if(parsed.displayMode !== undefined && (!parsed.display || parsed.display.displayMode === undefined)){
                if(!parsed.display) parsed.display = {};
                parsed.display.displayMode = parsed.displayMode;
                delete parsed.displayMode;
            }

            mergeDeep(data, parsed);

        }

    }catch(e){}

}

function save(){

    try{

        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    }catch(e){}

}

function notify(){

    const snapshot = JSON.parse(JSON.stringify(data));

    listeners.forEach(fn=>{

        try{ fn(snapshot); }catch(e){}

    });

    if(configChannel){
        try{
            configChannel.postMessage({ type:"config_update", config: snapshot, timestamp: Date.now() });
        }catch(e){}
    }

    try{
        localStorage.setItem("overlayConfigBroadcast", JSON.stringify({ config: snapshot, timestamp: Date.now() }));
    }catch(e){}

}

if(configChannel){
    configChannel.onmessage = function(e){
        if(!e.data || e.data.type !== "config_update" || !e.data.config) return;
        mergeDeep(data, e.data.config);
        const snapshot = JSON.parse(JSON.stringify(data));
        listeners.forEach(fn=>{ try{ fn(snapshot); }catch(err){} });
    };
}

window.OverlayConfig = {

    get(){
        return JSON.parse(JSON.stringify(data));
    },

    set(patch){
        mergeDeep(data, patch);
        save();
        notify();
    },

    subscribe(fn){
        listeners.push(fn);
        try{ fn(JSON.parse(JSON.stringify(data))); }catch(e){}
    }

};

load();

})();
