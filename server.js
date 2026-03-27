const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;


const OBSERVER_TIMEOUT = 30000;         
const MAX_KILLS = 3000;

const WEAPON_CACHE_TTL = 8000;
const BACKPACK_CACHE_TTL = 2000;

const WEAPON_FETCH_TIMEOUT = 1200;


const SNAPSHOT_CACHE_TTL = 150;         
const FREEZE_DURATION = 30000;          
const MAX_OBSERVER_AGE = 5000;           
const MAX_SNAPSHOT_STALE = 3000;          



const DATA_DIR = "./data";

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

const CONFIG_FILE = path.join(DATA_DIR, "tournament_config.json");
const TOURNAMENT_FILE = path.join(DATA_DIR, "tournaments.json");



const observers = new Map();

let masterObserver = null;
let masterSnapshot = {};

let currentGameID = null;

let matchFinishedTime = 0;

let gameStartLockUntil = 0;


const processedMatches = new Set();
let lastFinishedGameID = null;



const killMap = new Map();
const killHistory = [];



const weaponCache = {
    timestamp: 0,
    data: {}
};



const backpackCache = {
    timestamp: 0,
    data: null
};



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


let tournamentConfig = loadJSON(CONFIG_FILE,{
    tournament:"",
    day:1,
    group:"A",
    match:1,
    sendToSheets:false,
    autoMatchIncrement:true,
    lastGameId:null
});



let tournaments = loadJSON(TOURNAMENT_FILE,[]);



let snapshotCache = {
    timestamp: 0,
    data: null
};

let frozenSnapshot = null;
let freezeUntil = 0;



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



function normalizeSnapshotFields(snap) {
    if (!snap) return snap;
    const normalized = { ...snap };
    const fromRoot   = Number(normalized.FinishedStartTime || 0);
    const fromAllinfo = Number(normalized.allinfo?.FinishedStartTime || 0);
    normalized.FinishedStartTime = fromRoot > 0 ? fromRoot : fromAllinfo;
    return normalized;
}



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
}



function hardResetMatch(newGameID){

    console.log("[HARD RESET] New GameID:", newGameID);

    resetMatch();

    masterSnapshot = {};

    observers.clear();
    masterObserver = null;

    processedMatches.clear();
    lastFinishedGameID = null;

    currentGameID = newGameID;
    matchFinishedTime = 0;
}



function isGameLocked(){
    return now() < gameStartLockUntil;
}



function safeResetMatch(newGameID){

    console.log("[SAFE RESET] New GameID:", newGameID);

    // Clear frozen snapshot immediately so new game data flows through
    frozenSnapshot = null;
    freezeUntil = 0;

    killMap.clear();
    killHistory.length = 0;

    // Reset matchFinishedTime immediately — new game started
    matchFinishedTime = 0;

    snapshotCache.data = null;
    snapshotCache.timestamp = 0;

    // Reduced lock: 3s is enough for PUBG to stabilize (was 10s → caused freeze)
    gameStartLockUntil = now() + 3000;

    setTimeout(()=>{
        hardResetMatch(newGameID);
    }, 500);
}


function selectMasterObserver(){

    const priority = ["obs1","obs2","obs3","obs4","obs5","obs6","obs7","obs8"];
    const nowTime = now();

    for(const id of priority){
        if(observers.has(id)){
            const obs = observers.get(id);

            if(
                obs &&
                obs.snapshot &&
                obs.snapshot.allinfo &&
                Array.isArray(obs.snapshot.allinfo.TotalPlayerList) &&
                obs.snapshot.allinfo.TotalPlayerList.length > 0 &&
                (nowTime - obs.timestamp) < MAX_OBSERVER_AGE
            ){
                masterObserver = id;
                return;
            }
        }
    }

    let bestObserver = null;
    let bestTime = 0;

    for(const [id, obs] of observers.entries()){
        if(
            obs &&
            obs.snapshot &&
            obs.snapshot.allinfo &&
            Array.isArray(obs.snapshot.allinfo.TotalPlayerList) &&
            obs.snapshot.allinfo.TotalPlayerList.length > 0
        ){
            if ((nowTime - obs.timestamp) < MAX_OBSERVER_AGE && obs.timestamp > bestTime) {
                bestObserver = id;
                bestTime = obs.timestamp;
            }
        }
    }

    if(bestObserver){
        masterObserver = bestObserver;
        return;
    }

    masterObserver = null;
}


function mergeKills(snapshot){

    const list = snapshot?.killinfo || [];

    for(const k of list){

        if(!isValidKill(k)) continue;

        const key = getKillKey(k);

        if(!killMap.has(key)){

            killMap.set(key,k);
            killHistory.push(k);
        }
    }

    killHistory.sort((a,b)=>
        Number(a.CurGameTime||0)-Number(b.CurGameTime||0)
    );

    if(killHistory.length > MAX_KILLS){
        killHistory.splice(0, killHistory.length - MAX_KILLS);
    }
}


function buildSnapshot(){

    if (isGameLocked()) {
        if (matchFinishedTime > 0) {
            console.log("[LOCK OVERRIDE] FinishedStartTime permitido:", matchFinishedTime);
        } else {
            console.log("[GAME LOCK] activo, restante:", gameStartLockUntil - now(), "ms");
            return masterSnapshot || {};
        }
    }

    selectMasterObserver();

    if(!masterObserver) {
        if (snapshotCache.data && (now() - snapshotCache.timestamp) > MAX_SNAPSHOT_STALE) {
            return {};
        }
        return masterSnapshot;
    }

    const master = observers.get(masterObserver);

    const nowTime = now();
    if (
        !master ||
        !master.snapshot ||
        !master.snapshot.allinfo ||
        !Array.isArray(master.snapshot.allinfo.TotalPlayerList) ||
        master.snapshot.allinfo.TotalPlayerList.length === 0 ||
        (nowTime - master.timestamp) > MAX_OBSERVER_AGE
    ){
        masterObserver = null;
        if (snapshotCache.data && (nowTime - snapshotCache.timestamp) > MAX_SNAPSHOT_STALE) {
            return {};
        }
        return masterSnapshot;
    }

    const base = master.snapshot;

    if (
        !base ||
        !base.allinfo ||
        !Array.isArray(base.allinfo.TotalPlayerList) ||
        base.allinfo.TotalPlayerList.length === 0
    ){
        if (snapshotCache.data && (nowTime - snapshotCache.timestamp) > MAX_SNAPSHOT_STALE) {
            return {};
        }
        return masterSnapshot;
    }

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

    const gameID = base.GameID || base?.allinfo?.GameID || null;

    masterSnapshot = {
        GameID: gameID,
        GameStartTime: base.GameStartTime || base.allinfo?.GameStartTime || 0,
        FightingStartTime: base.FightingStartTime || base.allinfo?.FightingStartTime || 0,
        FinishedStartTime: matchFinishedTime > 0
            ? matchFinishedTime
            : Number(
                base.FinishedStartTime ||
                base.allinfo?.FinishedStartTime ||
                0
            ),
        CurrentTime: base.CurrentTime || base.allinfo?.CurrentTime || 0,
        allinfo: base.allinfo,
        killinfo: killHistory,
        circleinfo: base.circleinfo,
        teambackpackinfo: base.teambackpackinfo || null,
        playerweapondetailinfo: Array.isArray(base.playerweapondetailinfo)
            ? base.playerweapondetailinfo : [],
        observer: "aggregator",
        observerName: "aggregator"
    };

    masterSnapshot = normalizeSnapshotFields(masterSnapshot);

    if (masterSnapshot.FinishedStartTime > 0) {
        console.log("[MATCH END] FinishedStartTime:", masterSnapshot.FinishedStartTime, "GameID:", masterSnapshot.GameID);
        if (!frozenSnapshot) {
            frozenSnapshot = { ...masterSnapshot };
            freezeUntil = now();
            console.log("[FROZEN] Snapshot final guardado — se servirá hasta nuevo GameID");
        } else {
            const incoming = masterSnapshot.playerweapondetailinfo;
            if (Array.isArray(incoming) && incoming.length > (frozenSnapshot.playerweapondetailinfo?.length || 0)) {
                frozenSnapshot.playerweapondetailinfo = incoming;
                console.log("[FROZEN] playerweapondetailinfo actualizado:", incoming.length, "entradas");
            }
        }
    }

    detectMatchEnd(masterSnapshot);

    return masterSnapshot;
}


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



app.post("/observer",(req,res)=>{

    const body = req.body;

    if(!body?.snapshot){
        return res.status(400).json({error:"invalid snapshot"});
    }

    const snapshot = body.snapshot;

    if (!snapshot.allinfo) {
        return res.status(400).json({error:"invalid snapshot: missing allinfo"});
    }
    if (!Array.isArray(snapshot.allinfo.TotalPlayerList)) {
        snapshot.allinfo.TotalPlayerList = [];
    }

    const id = body.observer || "observer";

    const incomingGameID = snapshot.GameID || snapshot?.allinfo?.GameID || null;

    if(incomingGameID && incomingGameID !== currentGameID){
        safeResetMatch(incomingGameID);
    }

    const incomingFinished = Number(
        snapshot.FinishedStartTime ||
        snapshot.allinfo?.FinishedStartTime ||
        0
    );

    if (incomingFinished > 0) {
        if (matchFinishedTime === 0) {
            console.log("[MATCH END DETECTED]", incomingFinished, "GameID:", incomingGameID);
        }
        matchFinishedTime = Math.max(matchFinishedTime, incomingFinished);
    }

    observers.set(id,{
        id,
        timestamp:now(),
        snapshot
    });

    mergeKills(snapshot);

    res.json({status:"ok"});
});


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


setInterval(async ()=>{

    let hasValidObserver = false;
    const nowTime = now();
    for(const obs of observers.values()){
        if(
            obs?.snapshot?.allinfo?.TotalPlayerList?.length > 0 &&
            (nowTime - obs.timestamp) < MAX_OBSERVER_AGE
        ){
            hasValidObserver = true;
            break;
        }
    }

    if(hasValidObserver) return;

    try{
        const r = await fetch("http://127.0.0.1:10086/getmatchsnapshot");
        const snapshot = await r.json();

        if(!snapshot || Object.keys(snapshot).length === 0) return;

        const id = "obs1";  

        const incomingGameID = snapshot.GameID || snapshot?.allinfo?.GameID || null;
        if(incomingGameID && incomingGameID !== currentGameID){
            safeResetMatch(incomingGameID);
        }

        const incomingFinished = Number(
            snapshot.FinishedStartTime ||
            snapshot.allinfo?.FinishedStartTime ||
            0
        );
        if (incomingFinished > 0) {
            matchFinishedTime = Math.max(matchFinishedTime, incomingFinished);
            if (matchFinishedTime === incomingFinished) {
                console.log("[FALLBACK] FinishedStartTime capturado:", matchFinishedTime);
            }
        }

        observers.set(id,{
            id,
            timestamp:now(),
            snapshot
        });

        mergeKills(snapshot);

    }catch(e){
    }
},1000);


app.get("/getmatchsnapshot",(req,res)=>{

    if (frozenSnapshot) {
        const newSnapshot = buildSnapshot() || {};

        if (
            newSnapshot?.allinfo?.TotalPlayerList?.length > 0 &&
            newSnapshot.GameID &&
            newSnapshot.GameID !== frozenSnapshot.GameID
        ) {
            console.log("[FREEZE RELEASE] Nuevo GameID con datos válidos:", newSnapshot.GameID);
            frozenSnapshot = null;
            freezeUntil = 0;
            snapshotCache.data = newSnapshot;
            snapshotCache.timestamp = now();
            return res.json(newSnapshot);
        }

        return res.json(frozenSnapshot);
    }

    if (
        snapshotCache.data &&
        snapshotCache.data.allinfo?.TotalPlayerList?.length > 0 &&
        (now() - snapshotCache.timestamp) < SNAPSHOT_CACHE_TTL
    ) {
        return res.json(snapshotCache.data);
    }

    const newSnapshot = buildSnapshot() || {};

    if (newSnapshot?.allinfo?.TotalPlayerList?.length > 0) {
        snapshotCache.data = newSnapshot;
        snapshotCache.timestamp = now();
    }

    res.json(newSnapshot);
});


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

let lastOverlayCommand = {
    cmd: null,
    timestamp: 0,
    source: null
};

const OVERLAY_BUFFER_SIZE = 10;
let overlayCommandsBuffer = [];

app.post("/overlaycommand", (req, res) => {
    const { cmd, timestamp, source } = req.body;

    if (!cmd || typeof cmd !== "string") {
        return res.status(400).json({ error: "missing or invalid cmd" });
    }
    if (!timestamp || typeof timestamp !== "number") {
        return res.status(400).json({ error: "missing or invalid timestamp" });
    }

    const nowTime = Date.now();
    if (nowTime - timestamp > 10000) {
        console.log("[OVERLAY CMD] Ignorado (demasiado viejo):", { cmd, timestamp });
        return res.json({ status: "ignored" });
    }

    if (timestamp > lastOverlayCommand.timestamp) {
        lastOverlayCommand = { cmd, timestamp, source: source || null };
        console.log("[OVERLAY CMD]", lastOverlayCommand);
    }

    const exists = overlayCommandsBuffer.some(e => e.timestamp === timestamp);
    if (!exists) {
        overlayCommandsBuffer.push({ cmd, timestamp, source: source || null });
        overlayCommandsBuffer.sort((a, b) => a.timestamp - b.timestamp);
        if (overlayCommandsBuffer.length > OVERLAY_BUFFER_SIZE) {
            overlayCommandsBuffer = overlayCommandsBuffer.slice(-OVERLAY_BUFFER_SIZE);
        }
    }

    res.json({ status: "ok" });
});

app.get("/overlaycommand", (req, res) => {
    res.json(lastOverlayCommand);
});

app.get("/overlaycommand/latest", (req, res) => {
    const since = parseInt(req.query.since, 10);

    if (isNaN(since)) {
        return res.json(lastOverlayCommand);
    }

    const newer = overlayCommandsBuffer
        .filter(e => e.timestamp > since)
        .pop();

    res.json(newer || null);
});



app.get("/observers", (req, res) => {
    const nowTime = now();
    const list = [];

    for (const [id, obs] of observers.entries()) {
        const ageSec = ((nowTime - obs.timestamp) / 1000).toFixed(1);
        const active = (nowTime - obs.timestamp) < OBSERVER_TIMEOUT;
        const fresh  = (nowTime - obs.timestamp) < MAX_OBSERVER_AGE;
        list.push({
            id,
            name: obs.snapshot?.observerName || id,
            isMaster: id === masterObserver,
            active,
            fresh,
            ageSec: parseFloat(ageSec),
            gameID: obs.snapshot?.GameID || obs.snapshot?.allinfo?.GameID || null
        });
    }

    res.json({
        count: list.length,
        active: list.filter(o => o.active).length,
        fresh: list.filter(o => o.fresh).length,
        master: masterObserver,
        observers: list
    });
});


app.post("/resetstate", (req, res) => {
    console.log("[MANUAL RESET] Solicitado por:", req.body?.source || "desconocido");

    frozenSnapshot = null;
    freezeUntil = 0;

    snapshotCache.data = null;
    snapshotCache.timestamp = 0;
    masterSnapshot = {};
    masterObserver = null;

    matchFinishedTime = 0;
    gameStartLockUntil = 0;
    currentGameID = null;

    killMap.clear();
    killHistory.length = 0;

    observers.clear();

    resetMatch();

    console.log("[MANUAL RESET] Estado limpiado completamente");
    res.json({ status: "ok", message: "Estado del aggregator reiniciado" });
});

app.get("/state", (req, res) => {
    res.json({
        currentGameID,
        matchFinishedTime,
        frozenSnapshot: frozenSnapshot ? {
            GameID: frozenSnapshot.GameID,
            FinishedStartTime: frozenSnapshot.FinishedStartTime,
            players: frozenSnapshot.allinfo?.TotalPlayerList?.length || 0
        } : null,
        freezeUntil,
        observerCount: observers.size,
        masterObserver,
        gameStartLockActive: isGameLocked(),
        gameStartLockRemainingMs: Math.max(0, gameStartLockUntil - now()),
        snapshotCacheAge: snapshotCache.data ? now() - snapshotCache.timestamp : null,
        killHistoryLength: killHistory.length,
    });
});


app.post("/gas-proxy", async (req, res) => {
    const { url, payload } = req.body;
    if (!url || !payload) {
        return res.status(400).json({ error: "url and payload required" });
    }
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            redirect: "follow",
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        try {
            res.json(JSON.parse(text));
        } catch (e) {
            res.send(text);
        }
    } catch (err) {
        console.error("[GAS PROXY] Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});



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
