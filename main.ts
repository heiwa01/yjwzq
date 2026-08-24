interface Client {
    ws: WebSocket;
    userName: string;
    roomId: string | null;
    side: number; //0未分配，1黑，2白
}

interface Room {
    roomId: string;
    clients: Set<Client>;
    board: number[][];
    turn: number;
    gameOver: boolean;
}

const clientMap = new Map<WebSocket, Client>();
const roomMap = new Map<string, Room>();
const BOARD_SIZE = 20;

function checkWin(board: number[][], x: number, y: number, color: number) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
        const points: { x: number; y: number }[] = [{ x, y }];
        let cx = x + dx;
        let cy = y + dy;
        while (cx >= 0 && cx < BOARD_SIZE && cy >= 0 && cy < BOARD_SIZE && board[cy][cx] === color) {
            points.push({ x: cx, y: cy });
            cx += dx;
            cy += dy;
        }
        cx = x - dx;
        cy = y - dy;
        while (cx >= 0 && cx < BOARD_SIZE && cy >= 0 && cy < BOARD_SIZE && board[cy][cx] === color) {
            points.push({ x: cx, y: cy });
            cx -= dx;
            cy -= dy;
        }
        if (points.length >= 5) return points;
    }
    return [];
}

function createEmptyBoard(): number[][] {
    const b: number[][] = [];
    for (let i = 0; i < BOARD_SIZE; i++) {
        b.push(Array(BOARD_SIZE).fill(0));
    }
    return b;
}

function broadcastRoom(room: Room, payload: Record<string, unknown>) {
    const str = JSON.stringify(payload);
    for (const c of room.clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(str);
        }
    }
}

function sendMsg(client: Client, payload: Record<string, unknown>) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(payload));
}

function getRoomList() {
    const arr: { roomId: string; playerCount: number }[] = [];
    for (const [rid, r] of roomMap) {
        arr.push({ roomId: rid, playerCount: r.clients.size });
    }
    return arr;
}


function broadcastRoomUpdate(room: Room) {
    const players = [];
    for (const c of room.clients) {
        players.push({ name: c.userName, side: c.side });
    }
    broadcastRoom(room, { type: "roomPlayerUpdate", data: { count: room.clients.size, players } });
}

function cleanRoomIfEmpty(roomId: string) {
    const r = roomMap.get(roomId);
    if (!r) return;
    if (r.clients.size === 0) {
        roomMap.delete(roomId);
    }
}

function handleClientClose(client: Client) {
    const oldRoomId = client.roomId;
    client.roomId = null;
    client.side = 0;
    if (oldRoomId) {
        const room = roomMap.get(oldRoomId);
        if (room) {
            // 收集剩余玩家
            const remaining: Client[] = [];
            for (const c of room.clients) {
                if (c !== client) remaining.push(c);
            }
            room.clients.delete(client);
            // 向剩余玩家发送离开通知和跑路消息
            for (const c of remaining) {
                if (c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(JSON.stringify({
                        type: "chatPush",
                        data: { sender: client.userName, msg: "已经离开了对局" }
                    }));
                    c.ws.send(JSON.stringify({
                        type: "opponentLeft",
                        data: { reason: `${client.userName}已经离开了对局` }
                    }));
                }
            }
            // 销毁房间
            roomMap.delete(oldRoomId);
        }
    }
    clientMap.delete(client.ws);
}

async function handleWs(sock: WebSocket) {
    const client: Client = {
        ws: sock,
        userName: "匿名玩家",
        roomId: null,
        side: 0
    };
    clientMap.set(sock, client);

    sock.onclose = () => {
        handleClientClose(client);
    };
    sock.onerror = () => {
        handleClientClose(client);
    };

    sock.onmessage = (ev) => {
        try {
            const raw = ev.data as string;
            const msg = JSON.parse(raw);
            const type: string = msg.type;
            const data = msg.data;

            switch (type) {
                case "setUserName": {
                    if (typeof data === "string" && data.trim().length > 0) {
                        client.userName = data.trim();
                    }
                    break;
                }
                case "requestRoomList": {
                    sendMsg(client, { type: "roomList", data: getRoomList() });
                    break;
                }
                case "createRoom": {
                    const rid = data.roomId;
                    if (!/^\d{6}$/.test(rid)) {
                        sendMsg(client, { type: "error", data: { msg: "房间ID必须是6位数字" } });
                        return;
                    }
                    if (roomMap.has(rid)) {
                        sendMsg(client, { type: "error", data: { msg: "该房间ID已经存在" } });
                        return;
                    }
                    const newRoom: Room = {
                        roomId: rid,
                        clients: new Set(),
                        board: createEmptyBoard(),
                        turn: 1,
                        gameOver: false
                    };
                    roomMap.set(rid, newRoom);
                    sendMsg(client, { type: "createRoomSuccess", data: { roomId: rid } });
                    break;
                }
                case "joinRoom": {
                    const rid = data.roomId;
                    const uname = data.userName || "匿名";
                    client.userName = uname.trim();

                    const room = roomMap.get(rid);
                    if (!room) {
                        sendMsg(client, { type: "joinFail", data: { msg: "房间不存在" } });
                        return;
                    }
                    if (room.clients.size >= 2) {
                        sendMsg(client, { type: "joinFail", data: { msg: "房间已满，最多2人" } });
                        return;
                    }
                    if (client.roomId) {
                        const oldR = roomMap.get(client.roomId);
                        if (oldR) {
                            oldR.clients.delete(client);
                            broadcastRoomUpdate(oldR);
                            cleanRoomIfEmpty(client.roomId);
                        }
                    }
                    client.roomId = rid;
                    room.clients.add(client);
                    if (room.clients.size === 1) {
                        client.side = 1;
                    } else {
                        client.side = 2;
                    }
                    sendMsg(client, { type: "joinSuccess", data: { roomId: rid } });
                    sendMsg(client, { type: "assignSide", data: { side: client.side } });
                    broadcastRoomUpdate(room);
                    sendMsg(client, { type: "boardUpdate", data: { board: room.board } });
                    break;
                }
                case "leaveRoom": {
                    const rid = data.roomId;
                    const room = roomMap.get(rid);
                    if (!room) return;
                    if (client.roomId !== rid) return;
                    // 收集剩余玩家（在删除当前玩家之前）
                    const remaining: Client[] = [];
                    for (const c of room.clients) {
                        if (c !== client) remaining.push(c);
                    }
                    client.roomId = null;
                    client.side = 0;
                    room.clients.delete(client);
                    // 向剩余玩家发送离开通知和跑路消息
                    for (const c of remaining) {
                        if (c.ws.readyState === WebSocket.OPEN) {
                            c.ws.send(JSON.stringify({
                                type: "chatPush",
                                data: { sender: client.userName, msg: "已经离开了对局" }
                            }));
                            c.ws.send(JSON.stringify({
                                type: "opponentLeft",
                                data: { reason: `${client.userName}已经离开了对局` }
                            }));
                        }
                    }
                    // 销毁房间
                    roomMap.delete(rid);
                    break;
                }
                case "placeChess": {
                    const rid = data.roomId;
                    const pos = Number(data.pos);
                    const room = roomMap.get(rid);
                    if (!room) {
                        sendMsg(client, { type: "error", data: { msg: "房间不存在" } });
                        return;
                    }
                    if (client.roomId !== rid) return;
                    if (room.gameOver) {
                        sendMsg(client, { type: "error", data: { msg: "本局游戏已经结束" } });
                        return;
                    }
                    if (client.side !== room.turn) {
                        sendMsg(client, { type: "error", data: { msg: "不是你的回合，请等待对手落子" } });
                        return;
                    }
                    const col = pos % BOARD_SIZE;
                    const row = Math.floor(pos / BOARD_SIZE);
                    if (col < 0 || col >= BOARD_SIZE || row < 0 || row >= BOARD_SIZE) return;
                    if (room.board[row][col] !== 0) {
                        sendMsg(client, { type: "error", data: { msg: "该位置已经有棋子" } });
                        return;
                    }
                    const color = client.side;
                    room.board[row][col] = color;
                    broadcastRoom(room, { type: "boardUpdate", data: { board: room.board } });
                    const winPoints = checkWin(room.board, col, row, color);
                    if (winPoints.length >= 5) {
                        room.gameOver = true;
                        const resText = color === 1 ? "黑方胜利" : "白方胜利";
                        broadcastRoom(room, {
                            type: "gameOver",
                            data: { winPoints: winPoints, resultText: resText }
                        });
                    } else {
                        room.turn = room.turn === 1 ? 2 : 1;
                    }
                    break;
                }
                case "chatMessage": {
                    const rid = data.roomId;
                    const msgText = String(data.msg || "").trim();
                    const sender = String(data.sender || client.userName);
                    const room = roomMap.get(rid);
                    if (!room) return;
                    if (client.roomId !== rid) return;
                    if (msgText.length > 200) return;
                    // 只广播给房间内其他玩家，不广播给发送者自己（发送者本地已显示）
                    for (const c of room.clients) {
                        if (c !== client && c.ws.readyState === WebSocket.OPEN) {
                            c.ws.send(JSON.stringify({
                                type: "chatPush",
                                data: { sender: sender, msg: msgText }
                            }));
                        }
                    }
                    break;
                }
            }
        } catch (e) {
            console.error("消息解析异常", e);
        }
    };
}

// Deno服务入口
Deno.serve({
    port: 8080,
    handler(req) {
        if (req.headers.get("upgrade") === "websocket") {
            const { socket, response } = Deno.upgradeWebSocket(req);
            handleWs(socket);
            return response;
        }
        return new Response("五子棋WebSocket服务 ws://127.0.0.1:8080", { status: 200 });
    }
});

console.log("五子棋WebSocket后端启动成功，监听 ws://127.0.0.1:8080");
