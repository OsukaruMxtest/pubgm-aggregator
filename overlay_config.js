(function(){

if(window.OverlayConfig) return;

const STORAGE_KEY = "overlayConfig";

const API_BASE = window.location.origin;
const GLOBAL_CONFIG_ENDPOINT = `${API_BASE}/api/overlay-config`;

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
    columns:{
        pp:true,
        total:true
    },
    utilities:{
        show:true
    },
    ui:{
        showTeamTable:true,
        showDropsRoutes:false
    },
    scoring:{
        pp:{ 1:10,2:8,3:6,4:5,5:4,6:3,7:2,8:1,9:1,10:1,11:0,12:0,13:0,14:0,15:0,16:0 },
        pePerKill:1,
        bonusEnabled:false,
        bonus:{
            grenade:3,
            vehicle:8,
            melee:13,
            molotov:3,
            distance:15,
            killDist:18
        }
    }
};

// Defaults garantizados para merge seguro en get()
const defaults = {
    columns:{ pp:false, total:false },
    utilities:{ show:true }
};

const listeners = [];

let configChannel = null;
let lastTimestamp = 0;
try{
    configChannel = new BroadcastChannel("pubgm_config");
}catch(e){}

/* ── SERVER SYNC STATE ──────────────────────────────────────────────────── */

let serverVersion = 0;
let applyingRemote = false;
let pendingServerSync = null;
let serverSyncEnabled = true;
let lastServerPushHash = "";

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function hash(obj) {
    try { return JSON.stringify(obj); } catch(e) { return ""; }
}

/* ── HELPERS ────────────────────────────────────────────────────────────── */

function mergeDeep(target, source){

    for(const key in source){

        if(!Object.prototype.hasOwnProperty.call(source, key)) continue;

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

let _savedSnapshot = "";

function load(){

    try{

        const stored = localStorage.getItem(STORAGE_KEY);

        if(stored){

            const parsed = JSON.parse(stored);

            // Migrar displayMode raíz legacy a display.displayMode
            if(parsed.displayMode !== undefined && (!parsed.display || parsed.display.displayMode === undefined)){
                if(!parsed.display) parsed.display = {};
                parsed.display.displayMode = parsed.displayMode;
                delete parsed.displayMode;
            }

            // Migrar claves legacy de columns: showPP → pp, showTotal → total
            if(parsed.columns){
                if(parsed.columns.showPP !== undefined && parsed.columns.pp === undefined){
                    parsed.columns.pp = parsed.columns.showPP;
                }
                if(parsed.columns.showTotal !== undefined && parsed.columns.total === undefined){
                    parsed.columns.total = parsed.columns.showTotal;
                }
            }

            // Migrar showThrowables legacy de ui.showThrowables → utilities.show
            if(parsed.ui && parsed.ui.showThrowables !== undefined && (!parsed.utilities || parsed.utilities.show === undefined)){
                if(!parsed.utilities) parsed.utilities = {};
                parsed.utilities.show = parsed.ui.showThrowables;
            }

            mergeDeep(data, parsed);

        }

        // Sincronizar snapshot para que save() no escriba innecesariamente
        _savedSnapshot = JSON.stringify(data);

    }catch(e){}

}

function save(){

    try{

        const serialized = JSON.stringify(data);
        if(serialized === _savedSnapshot) return;
        _savedSnapshot = serialized;
        localStorage.setItem(STORAGE_KEY, serialized);

    }catch(e){}

}

function notify(shouldBroadcast = true){

    const snapshot = JSON.parse(JSON.stringify(data));

    listeners.forEach(fn=>{

        try{ fn(snapshot); }catch(e){}

    });

    if (!shouldBroadcast) return;

    // Broadcast a otros overlays/pestañas
    const ts = Date.now();

    if(configChannel){
        try{
            lastTimestamp = ts;
            configChannel.postMessage({ type:"config_update", config: snapshot, timestamp: ts });
        }catch(e){}
    }

    // Fallback localStorage para overlays sin BroadcastChannel
    try{
        localStorage.setItem("overlayConfigBroadcast", JSON.stringify({ config: snapshot, timestamp: ts }));
    }catch(e){}

}

// Recibir cambios de config desde otras pestañas
if(configChannel){
    configChannel.onmessage = function(e){
        if(!e.data || e.data.type !== "config_update" || !e.data.config) return;
        if(e.data.timestamp <= lastTimestamp) return;
        lastTimestamp = e.data.timestamp;
        applyingRemote = true;
        mergeDeep(data, e.data.config);
        save();
        applyingRemote = false;
        notify(false);
    };
}

// Fallback: escuchar overlayConfigBroadcast para pestañas sin BroadcastChannel
window.addEventListener("storage", function(e){
    if(e.key !== "overlayConfigBroadcast" || !e.newValue) return;
    try{
        const msg = JSON.parse(e.newValue);
        if(!msg || !msg.config) return;
        if(msg.timestamp <= lastTimestamp) return;
        lastTimestamp = msg.timestamp;
        applyingRemote = true;
        mergeDeep(data, msg.config);
        save();
        applyingRemote = false;
        notify(false);
    }catch(err){}
});

/* ── SERVER SYNC FUNCTIONS ──────────────────────────────────────────────── */

async function fetchServerConfig() {
    try {
        const res = await fetch(GLOBAL_CONFIG_ENDPOINT, {
            cache: "no-store"
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();

        if (!json || !json.config) return false;

        const incomingVersion = Number(json.version || json.updatedAt || 0);

        if (incomingVersion && incomingVersion <= serverVersion) {
            return false;
        }

        serverVersion = incomingVersion || Date.now();

        applyingRemote = true;
        mergeDeep(data, json.config);
        save();
        applyingRemote = false;

        notify(false);

        return true;

    } catch (err) {
        console.warn("[OverlayConfig] Server config unavailable, using local fallback", err.message);
        return false;
    }
}

async function pushServerConfig(patch) {
    if (applyingRemote) return;
    if (!serverSyncEnabled) return;

    const patchHash = hash(patch);
    if (!patchHash || patchHash === lastServerPushHash) return;

    try {
        const res = await fetch(GLOBAL_CONFIG_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(patch)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        lastServerPushHash = patchHash;

        const json = await res.json();

        if (json && json.config) {
            serverVersion = Number(json.version || json.updatedAt || Date.now());

            applyingRemote = true;
            mergeDeep(data, json.config);
            save();
            applyingRemote = false;

            notify(false);
        }

    } catch (err) {
        console.warn("[OverlayConfig] Failed to push server config, local fallback active", err.message);
    }
}

/* ── PUBLIC API ─────────────────────────────────────────────────────────── */

window.OverlayConfig = {

    get(){
        // Merge seguro: defaults garantizan que columns y utilities nunca estén incompletos
        const stored = JSON.parse(JSON.stringify(data));
        return {
            ...stored,
            columns: { ...defaults.columns, ...stored.columns },
            utilities: { ...defaults.utilities, ...(stored.utilities || {}) }
        };
    },

    set(patch){
        mergeDeep(data, patch);
        save();
        notify(true);

        if (!applyingRemote) {
            clearTimeout(pendingServerSync);
            pendingServerSync = setTimeout(() => {
                pushServerConfig(patch);
            }, 80);
        }
    },

    subscribe(fn){
        listeners.push(fn);
        try{ fn(this.get()); }catch(e){}
        return ()=>{
            const i = listeners.indexOf(fn);
            if(i >= 0) listeners.splice(i, 1);
        };
    },

    syncNow() {
        return fetchServerConfig();
    }

};

/* ── INIT ───────────────────────────────────────────────────────────────── */

load();

fetchServerConfig();

setInterval(() => {
    fetchServerConfig();
}, 1500);

})();
