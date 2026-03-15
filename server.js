const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

/*
================================================
CONFIG
================================================
*/

const OBSERVER_TIMEOUT = 30000;          // Aumentado a 30s para evitar desconexiones prematuras
const MAX_KILLS = 3000;

const WEAPON_CACHE_TTL = 8000;
const BACKPACK_CACHE_TTL = 2000;

const WEAPON_FETCH_TIMEOUT = 1200;

// ========== MEJORAS PRO ==========
const SNAPSHOT_CACHE_TTL = 150;          // ms
const FREEZE_DURATION = 5000;            // ms

/*
================================================
TOURNAMENT STORAGE
================================================
*/

const DATA_DIR = "./data";

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

const CONFIG_FILE = path.join(DATA_DIR, "tournament_config.json");
const TOURNAMENT_FILE = path.join(DATA_DIR, "tournaments.json");

/*
================================================
STATE
================================================
*/

const observers = new Map();

let masterObserver = null;
let masterSnapshot = {};

let currentGameID = null;

/*
================================================
MATCH PROCESSING STATE
================================================
*/

const processedMatches = new Set();
let lastFinishedGameID = null;

/*
================================================
KILL STORAGE
================================================
*/

const killMap = new Map();
const killHistory = [];

/*
================================================
WEAPON CACHE
================================================
*/

const weaponCache = {
    timestamp: 0,
    data: {}
};

/*
================================================
BACKPACK CACHE
================================================
*/

const backpackCache = {
    timestamp: 0,
    data: null
};

/*
================================================
BONUS + PERFORMANCE TRACKING
================================================
*/

const matchStats = {

    grenadeKills:{},
    molotovKills:{},
    vehicleKills:{},

    longestKill:{
        distance:0,
        team:null
    },

    longestRun:{
        distance:0,
        team:null
    },

    longestBlueZone:{
        time:0,
        team:null
    },

    players:{},
    teams:{}
};

/*
================================================
TOURNAMENT CONFIG
================================================
*/

let tournamentConfig = loadJSON(CONFIG_FILE,{
    tournament:"",
    day:1,
    group:"A",
    match:1,
    sendToSheets:false,
    autoMatchIncrement:true,
    lastGameId:null
});

/*
================================================
TOURNAMENT DB
================================================
*/

let tournaments = loadJSON(TOURNAMENT_FILE,[]);

/*
================================================
MEJORAS: CACHE Y FREEZE
================================================
*/

let snapshotCache = {
    timestamp: 0,
    data: null
};

let frozenSnapshot = null;
let freezeUntil = 0;

/*
================================================
UTIL
================================================
*/

function now(){
    return Date.now();
}

function loadJSON(file,def){

    try{
        if(!fs.existsSync(file)) return def;
        return JSON.parse(fs.readFileSync(file));
    }catch(e){
        return def;
    }
}

function saveJSON(file,data){
    fs.writeFileSync(file,JSON.stringify(data,null,2));
}

function getKillKey(k){

    if (!k) return null;

    const attacker = k.CauserUID || "";
    const victim = k.VictimUID || "";
    const time = k.CurGameTime || "";
    const weapon = k.ItemID || "";

    return `${attacker}_${victim}_${time}_${weapon}`;
}

function isValidKill(k){

    if (!k) return false;

    if (!k.CauserUID) return false;
    if (!k.VictimUID) return false;

    const t = Number(k.CurGameTime || 0);

    if (t < 0 || t > 72000) return false;

    return true;
}

/*
================================================
NORMALIZACIÓN DE CAMPOS
================================================
*/

function normalizeSnapshotFields(snap) {
    if (!snap) return snap;
    const normalized = { ...snap };
    if ((!normalized.FinishedStartTime || normalized.FinishedStartTime === 0) && normalized.allinfo?.FinishedStartTime) {
        normalized.FinishedStartTime = Number(normalized.allinfo.FinishedStartTime);
    }
    return normalized;
}

/*
================================================
RESET MATCH
================================================
*/

function resetMatch(){

    killMap.clear();
    killHistory.length = 0;

    weaponCache.data = {};
    weaponCache.timestamp = 0;

    backpackCache.data = null;
    backpackCache.timestamp = 0;

    matchStats.grenadeKills = {};
    matchStats.molotovKills = {};
    matchStats.vehicleKills = {};

    matchStats.longestKill = {distance:0,team:null};
    matchStats.longestRun = {distance:0,team:null};
    matchStats.longestBlueZone = {time:0,team:null};

    matchStats.players = {};
    matchStats.teams = {};

    snapshotCache.data = null;
    snapshotCache.timestamp = 0;
    frozenSnapshot = null;
    freezeUntil = 0;
}

/*
================================================
MASTER OBSERVER
================================================
*/

function selectMasterObserver(){

    const priority = [
        "obs1",
        "obs2",
        "obs3",
        "obs4",
        "obs5",
        "obs6",
        "obs7",
        "obs8"
    ];

    for(const id of priority){

        if(observers.has(id)){

            const obs = observers.get(id);

            if(obs && obs.snapshot){

                masterObserver = id;
                return;

            }
        }
    }

    masterObserver = null;
}

/*
================================================
MERGE KILLS (CORREGIDO: SE ELIMINÓ EL CONTEO DE MOLOTOV)
================================================
*/

function mergeKills(snapshot){

    const list = snapshot?.killinfo || [];

    for(const k of list){

        if(!isValidKill(k)) continue;

        const key = getKillKey(k);

        if(!killMap.has(key)){

            killMap.set(key,k);
            killHistory.push(k);

            // ELIMINADO: el conteo de molotov aquí para evitar duplicados
            // Ahora solo se cuenta mediante killNumByMolotov en buildSnapshot
        }
    }

    killHistory.sort((a,b)=>
        Number(a.CurGameTime||0)-Number(b.CurGameTime||0)
    );

    if(killHistory.length > MAX_KILLS){
        killHistory.splice(0, killHistory.length - MAX_KILLS);
    }
}

/*
================================================
BUILD SNAPSHOT (CORREGIDO: GAMEID DESDE RAÍZ O ALLINFO)
================================================
*/

function buildSnapshot(){

    if(!masterObserver || !observers.has(masterObserver)){
        selectMasterObserver();
    }

    if(!masterObserver) return masterSnapshot;

    const master = observers.get(masterObserver);

    if(!master?.snapshot) return masterSnapshot;

    const base = master.snapshot;

    // === REINICIO COMPLETO DE BONUS PARA EVITAR ACUMULACIÓN ===
    matchStats.grenadeKills = {};
    matchStats.vehicleKills = {};
    matchStats.molotovKills = {};
    matchStats.longestKill = { distance: 0, team: null };
    matchStats.longestRun = { distance: 0, team: null };
    matchStats.longestBlueZone = { time: 0, team: null };
    matchStats.players = {};
    matchStats.teams = {};

    const players = base?.allinfo?.TotalPlayerList || [];

    for(const p of players){

        const team = p.TeamID;

        const grenadeKills = Number(p.killNumByGrenade || 0);
        const vehicleKills = Number(p.killNumInVehicle || 0);
        const molotovKills = Number(p.killNumByMolotov || 0);

        const longestKill = Number(p.maxKillDistance || 0);
        const runDistance = Number(p.marchDistance || 0);
        const blueTime = Number(p.outsideBlueCircleTime || 0);

        // Acumulación sin condiciones (incluye ceros)
        matchStats.grenadeKills[team] = (matchStats.grenadeKills[team] || 0) + grenadeKills;
        matchStats.vehicleKills[team] = (matchStats.vehicleKills[team] || 0) + vehicleKills;
        matchStats.molotovKills[team] = (matchStats.molotovKills[team] || 0) + molotovKills;

        if(longestKill > matchStats.longestKill.distance){
            matchStats.longestKill = { distance: longestKill, team };
        }

        if(runDistance > matchStats.longestRun.distance){
            matchStats.longestRun = { distance: runDistance, team };
        }

        if(blueTime > matchStats.longestBlueZone.time){
            matchStats.longestBlueZone = { time: blueTime, team };
        }

        matchStats.players[p.UID] = {
            name: p.PlayerName,
            team,
            kills: Number(p.KillNum || 0),
            damage: Number(p.Damage || 0),
            rank: Number(p.Rank || 99)
        };

        if(!matchStats.teams[team]){
            matchStats.teams[team] = { kills:0, damage:0, rank:99 };
        }

        matchStats.teams[team].kills += Number(p.KillNum || 0);
        matchStats.teams[team].damage += Number(p.Damage || 0);

        if(p.Rank < matchStats.teams[team].rank){
            matchStats.teams[team].rank = p.Rank;
        }
    }

    // CORREGIDO: GameID puede venir en la raíz o en allinfo
    const gameID = base.GameID || base?.allinfo?.GameID || null;

    masterSnapshot = {
        GameID: gameID,
        GameStartTime: base.GameStartTime,
        FightingStartTime: base.FightingStartTime,
        FinishedStartTime: base.FinishedStartTime,
        CurrentTime: base.CurrentTime,
        allinfo: base.allinfo,
        killinfo: killHistory,
        circleinfo: base.circleinfo,
        teambackpackinfo: base.teambackpackinfo || null,
        observer: "aggregator",
        observerName: "aggregator"
    };

    masterSnapshot = normalizeSnapshotFields(masterSnapshot);

    if (masterSnapshot.FinishedStartTime > 0) {
        if (!frozenSnapshot) {
            frozenSnapshot = { ...masterSnapshot };
            freezeUntil = now() + FREEZE_DURATION;
        }
    }

    detectMatchEnd(masterSnapshot);

    return masterSnapshot;
}

/*
================================================
MATCH DETECTION
================================================
*/

function detectMatchEnd(snapshot){

    const gid = snapshot.GameID;
    const finished = Number(snapshot.FinishedStartTime || 0);

    if(!gid) return;

    if(finished > 0){

        if(processedMatches.has(gid)) return;

        processedMatches.add(gid);

        processMatchResults(snapshot);
    }
}

/*
================================================
RESULT PROCESSOR
================================================
*/

function processMatchResults(snapshot){

    const teams={};

    for(const team in matchStats.teams){

        teams[team]={
            team,
            pp:0,
            pe:matchStats.teams[team].kills,
            total:0
        };
    }

    const list=Object.values(teams);

    list.sort((a,b)=>b.pe-a.pe);

    list.forEach((t,i)=>{

        const rank=i+1;

        if(rank===1)t.pp=15;
        else if(rank===2)t.pp=12;
        else if(rank===3)t.pp=10;
        else if(rank===4)t.pp=8;
        else if(rank===5)t.pp=6;
        else if(rank===6)t.pp=4;
        else if(rank===7)t.pp=2;
        else t.pp=1;

        t.total=t.pp+t.pe;
    });

    if(tournamentConfig.autoMatchIncrement){
        tournamentConfig.match+=1;
        saveJSON(CONFIG_FILE,tournamentConfig);
    }
}

/*
================================================
POST OBSERVER SNAPSHOT
================================================
*/

app.post("/observer",(req,res)=>{

    const body = req.body;

    if(!body?.snapshot){
        return res.status(400).json({error:"invalid snapshot"});
    }

    const snapshot = body.snapshot;
    const id = body.observer || "observer";

    const incomingGameID = snapshot.GameID || snapshot?.allinfo?.GameID || null;

    if(incomingGameID && incomingGameID !== currentGameID){
        resetMatch();
        currentGameID = incomingGameID;
    }

    observers.set(id,{
        id,
        timestamp:now(),
        snapshot
    });

    mergeKills(snapshot);

    res.json({status:"ok"});
});

/*
================================================
REMOVE DEAD OBSERVERS
================================================
*/

setInterval(()=>{

    const t = now();

    for(const [id,obs] of observers.entries()){

        if(t - obs.timestamp > OBSERVER_TIMEOUT){

            observers.delete(id);

            if(masterObserver === id){
                masterObserver = null;
            }
        }
    }

},2000);

/*
================================================
FALLBACK OBSERVER POLLING
================================================
*/

setInterval(async ()=>{

    if(observers.size > 0) return;

    try{
        const r = await fetch("http://127.0.0.1:10086/getmatchsnapshot");
        const snapshot = await r.json();

        if(!snapshot || Object.keys(snapshot).length === 0) return;

        const id = "fallback-observer";

        const incomingGameID = snapshot.GameID || snapshot?.allinfo?.GameID || null;
        if(incomingGameID && incomingGameID !== currentGameID){
            resetMatch();
            currentGameID = incomingGameID;
        }

        observers.set(id,{
            id,
            timestamp:now(),
            snapshot
        });

        mergeKills(snapshot);

    }catch(e){
        // Silencio
    }
},1000);

/*
================================================
SNAPSHOT ENDPOINT
================================================
*/

app.get("/getmatchsnapshot",(req,res)=>{

    if (freezeUntil > now() && frozenSnapshot) {
        return res.json(frozenSnapshot);
    }

    if (snapshotCache.data && (now() - snapshotCache.timestamp) < SNAPSHOT_CACHE_TTL) {
        return res.json(snapshotCache.data);
    }

    const newSnapshot = buildSnapshot() || {};
    snapshotCache.data = newSnapshot;
    snapshotCache.timestamp = now();

    res.json(newSnapshot);
});

/*
================================================
ADDED ENDPOINTS (NO EXISTING CODE MODIFIED)
================================================
*/

app.get("/tournamentconfig",(req,res)=>{
    res.json(tournamentConfig);
});

app.post("/tournamentconfig",(req,res)=>{

    tournamentConfig={
        ...tournamentConfig,
        ...req.body
    };

    saveJSON(CONFIG_FILE,tournamentConfig);

    res.json(tournamentConfig);
});

app.get("/gettournaments",(req,res)=>{
    res.json(tournaments);
});

app.post("/createtournament",(req,res)=>{

    const t=req.body;

    tournaments.push(t);

    saveJSON(TOURNAMENT_FILE,tournaments);

    res.json({status:"created"});
});

app.delete("/deletetournament",(req,res)=>{

    const id=req.query.id;

    tournaments=tournaments.filter(t=>t.id!==id);

    saveJSON(TOURNAMENT_FILE,tournaments);

    res.json({status:"deleted"});
});

app.get("/gettournamentcalendar",(req,res)=>{

    const id=req.query.id;

    const t=tournaments.find(x=>x.id===id);

    res.json(t?.schedule || []);
});

app.post("/savetournamentcalendar",(req,res)=>{

    const {id,schedule}=req.body;

    const t=tournaments.find(x=>x.id===id);

    if(t){
        t.schedule=schedule;
        saveJSON(TOURNAMENT_FILE,tournaments);
    }

    res.json({status:"saved"});
});

app.get("/gettournamentstandings",(req,res)=>{
    res.json({teams:[]});
});

/*
================================================
TELEMETRY PROXY - WEAPON
================================================
*/

app.get("/getplayerweapondetailinfo",async(req,res)=>{

    const t = now();

    if(t - weaponCache.timestamp < WEAPON_CACHE_TTL){
        return res.json(weaponCache.data);
    }

    try{

        const controller = new AbortController();
        const timeout = setTimeout(()=>controller.abort(), WEAPON_FETCH_TIMEOUT);

        const r = await fetch(
            "http://127.0.0.1:10086/getplayerweapondetailinfo",
            { signal: controller.signal }
        );

        clearTimeout(timeout);

        const data = await r.json();

        weaponCache.data = data;
        weaponCache.timestamp = now();

        res.json(data);

    }catch(e){

        if(weaponCache.data && Object.keys(weaponCache.data).length > 0){
            return res.json(weaponCache.data);
        }

        res.status(502).json({error:"observer unavailable"});
    }
});

/*
================================================
TELEMETRY PROXY - BACKPACK
================================================
*/

app.get("/getteambackpackinfo",async(req,res)=>{

    const t = now();

    if(t - backpackCache.timestamp < BACKPACK_CACHE_TTL && backpackCache.data !== null){
        return res.json(backpackCache.data);
    }

    try{

        const r = await fetch("http://127.0.0.1:10086/getteambackpackinfo");

        const data = await r.json();

        backpackCache.data = data;
        backpackCache.timestamp = now();

        res.json(data);

    }catch(e){

        if(backpackCache.data !== null){
            return res.json(backpackCache.data);
        }

        res.status(502).json({error:"observer unavailable"});
    }
});

/* ==================================================================
   OVERLAY COMMAND SYSTEM (AGREGADO SIN MODIFICAR NADA EXISTENTE)
   ================================================================== */

let lastOverlayCommand = {
    cmd: null,
    timestamp: 0
};

// POST /overlaycommand – recibir comandos del panel de control
app.post("/overlaycommand", (req, res) => {
    const { cmd, timestamp } = req.body;

    if (!cmd || typeof cmd !== "string") {
        return res.status(400).json({ error: "missing or invalid cmd" });
    }
    if (!timestamp || typeof timestamp !== "number") {
        return res.status(400).json({ error: "missing or invalid timestamp" });
    }

    // Solo aceptar si el timestamp es más reciente que el último almacenado
    if (timestamp > lastOverlayCommand.timestamp) {
        lastOverlayCommand = { cmd, timestamp };
        console.log("[OVERLAY CMD]", lastOverlayCommand);
    }

    res.json({ status: "ok" });
});

// GET /overlaycommand – los overlays consultan el último comando
app.get("/overlaycommand", (req, res) => {
    res.json(lastOverlayCommand);
});

/* ==================================================================
   FIN DEL SISTEMA DE COMANDOS
   ================================================================== */

/*
================================================
START
================================================
*/

app.listen(PORT,()=>{

    console.log("=================================");
    console.log(" PUBG MOBILE AGGREGATOR PRO");
    console.log(" Multi Observer Enabled");
    console.log(" Bonus System Enabled");
    console.log(" Fallback Polling Active");
    console.log("=================================");

    console.log(`PORT: ${PORT}`);
    console.log(`Snapshot: http://localhost:${PORT}/getmatchsnapshot`);
});