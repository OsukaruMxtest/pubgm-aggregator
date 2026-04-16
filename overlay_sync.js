(function(){

if(window.OverlaySync) return;

const channel = new BroadcastChannel("pubgm_overlay");

function broadcast(command){

    channel.postMessage({
        command: command,
        timestamp: Date.now()
    });
}

channel.onmessage = function(e){

    if(!e.data) return;

    const cmd =
        typeof e.data === "string"
            ? e.data
            : e.data.command;

    if(!cmd) return;

    // FIX #2: guard para evitar ReferenceError si OverlayBus no cargó aún
    if(window.OverlayBus){
        window.OverlayBus.emit(cmd, e.data);
    }

};


function rebuildPlayersFromSnapshot(snapshot){

    if(!snapshot) return [];

    const players = [];

    const playerList =
        snapshot.TotalPlayerList ||
        snapshot.totalPlayerList ||
        snapshot.players ||
        [];

    const teamInfoList =
        snapshot.TeamInfoList ||
        snapshot.teamInfoList ||
        [];

    const teamMap = new Map();

    teamInfoList.forEach(team => {

        const teamId =
            team.teamId ||
            team.TeamID ||
            team.teamID;

        if(teamId !== undefined){
            teamMap.set(teamId, team);
        }

    });

    playerList.forEach(p => {

        const teamId =
            p.teamId ||
            p.TeamID ||
            p.teamID ||
            0;

        const team =
            teamMap.get(teamId) || {};

        players.push({

            uId:
                p.uId ||
                p.UID ||
                p.uid ||
                null,

            playerName:
                p.playerName ||
                p.PlayerName ||
                p.name ||
                "Unknown",

            teamId: teamId,

            teamName:
                p.teamName ||
                team.teamName ||
                team.TeamName ||
                `Team ${teamId}`,

            rank:
                p.rank ||
                p.Rank ||
                999,

            killNum:
                p.killNum ||
                p.KillNum ||
                0,

            damage:
                p.damage ||
                p.Damage ||
                0,

            liveState:
                p.liveState ||
                p.LiveState ||
                0,

            marchDistance:
                p.marchDistance ||
                p.MarchDistance ||
                0,

            maxKillDistance:
                p.maxKillDistance ||
                p.MaxKillDistance ||
                0,

            killNumByGrenade:
                p.killNumByGrenade ||
                p.KillNumByGrenade ||
                0,

            killNumInVehicle:
                p.killNumInVehicle ||
                p.KillNumInVehicle ||
                0

        });

    });

    return players;

}


window.OverlaySync = {
    broadcast,
    rebuildPlayersFromSnapshot   // FIX #1: exponer en el objeto correcto
};

})();
