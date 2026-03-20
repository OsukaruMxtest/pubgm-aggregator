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
    }
};

const listeners = [];

function mergeDeep(target, source){

    for(const key in source){

        if(typeof source[key] === "object" && source[key] !== null){

            if(!target[key]) target[key] = {};

            Object.assign(target[key], source[key]);

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

    listeners.forEach(fn=>{

        try{ fn(data); }catch(e){}

    });

}

window.OverlayConfig = {

    get(){

        return data;

    },

    set(patch){

        mergeDeep(data, patch);

        save();

        notify();

    },

    subscribe(fn){

        listeners.push(fn);

    }

};

load();

})();