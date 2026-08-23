const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const io = new Server(PORT, {

  cors: { origin: "*" }
});

//房间集合
const rooms = new Map();

/**
 * 创建6位房间ID
 */
function genRoomId(){
  return Math.random().toString(36).slice(2,8);
}

/**
 * 获取房间对外展示信息
 */
function getRoomPublicInfo(roomId){
  const r = rooms.get(roomId);
  if(!r) return null;
  const count = r.players.length;
  let statusText;
  if(count === 0) statusText = "0/2";
  else if(count ===1) statusText = "1/2";
  else statusText = "2/2";
  return {
    roomId: roomId,
    status: statusText,
    playerCount: count,
    blackName: r.gameInfo.blackName,
    whiteName: r.gameInfo.whiteName
  }
}

/**
 * 获取全部房间列表（全部对外展示）
 */
function getAllRoomList(){
  const list = [];
  for(const rid of rooms.keys()){
    const info = getRoomPublicInfo(rid);
    if(info) list.push(info);
  }
  return list;
}

/**
 * 20×20五子棋判赢
 */
function checkWin(board, pos){
  const size = 20;
  const x = pos % size;
  const y = Math.floor(pos / size);
  const player = board[pos];
  if(player === 0) return false;
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for(const [dx,dy] of dirs){
    let cnt = 1;
    for(let i=1;i<5;i++){
      const nx = x + dx*i;
      const ny = y + dy*i;
      if(nx<0||nx>=size||ny<0||ny>=size) break;
      const idx = ny*size + nx;
      if(board[idx] === player) cnt++;
      else break;
    }
    for(let i=1;i<5;i++){
      const nx = x - dx*i;
      const ny = y - dy*i;
      if(nx<0||nx>=size||ny<0||ny>=size) break;
      const idx = ny*size + nx;
      if(board[idx] === player) cnt++;
      else break;
    }
    if(cnt >=5) return true;
  }
  return false;
}

io.on("connection", (socket)=>{
  console.log("客户端连接：", socket.id);
  let myUserName = "匿名玩家";

  // 设置玩家昵称
  socket.on("setUserName", (name)=>{
    myUserName = String(name || "匿名玩家").substring(0,20);
  });

  // 创建房间
  socket.on("createRoom", ()=>{
    const roomId = genRoomId();
    const board = Array(400).fill(0);
    rooms.set(roomId, {
      players: [socket.id],
      board: board,
      turn: 1, //1黑先行，2白
      gameOver: false,
      createTime: Date.now(),
      gameInfo:{
        startTime: Date.now(),
        blackName: myUserName,
        whiteName: ""
      }
    });
    socket.join(roomId);
    socket.emit("roomCreated", {roomId, selfRole:"black"});
    io.emit("hallUpdate", getAllRoomList());
  });

  // 请求大厅全部房间列表
  socket.on("requestHall", ()=>{
    socket.emit("hallList", getAllRoomList());
  });

  // 加入房间
  socket.on("joinRoom", (roomId)=>{
    const room = rooms.get(roomId);
    if(!room){
      socket.emit("joinFail", {msg:"该房间不存在或者已经失效"});
      return;
    }
    const pcount = room.players.length;
    if(pcount !== 1){
      if(pcount === 0){
        socket.emit("joinFail", {msg:"0/2空房间，禁止加入"});
      }else if(pcount ===2){
        socket.emit("joinFail", {msg:"2/2房间已满，禁止加入"});
      }
      return;
    }
    //可以加入
    socket.join(roomId);
    room.players.push(socket.id);
    room.gameInfo.whiteName = myUserName;
    socket.emit("joinSuccess", {roomId, selfRole:"white",
      blackName: room.gameInfo.blackName,
      whiteName: room.gameInfo.whiteName,
      board: room.board,
      turn: room.turn
    });
    io.to(roomId).emit("opponentEnter", {
      blackName: room.gameInfo.blackName,
      whiteName: room.gameInfo.whiteName
    });
    io.emit("hallUpdate", getAllRoomList());
  });

  //房间聊天
  socket.on("roomChat", ({roomId, text})=>{
    const room = rooms.get(roomId);
    if(!room) return;
    const safeText = String(text).substring(0,100);
    socket.to(roomId).emit("chatMessage", {
      fromName: myUserName,
      content: safeText
    })
  });

  //落子
  socket.on("placeChess", ({roomId, pos})=>{
    const room = rooms.get(roomId);
    if(!room || room.gameOver) return;
    const {players, turn, board} = room;
    const selfIdx = players.indexOf(socket.id);
    if(selfIdx === -1) return;
    const myRole = selfIdx ===0 ? 1 :2;
    //校验回合
    if(myRole !== turn) return;
    //坐标校验 20*20
    if(pos <0 || pos >=400) return;
    if(board[pos] !== 0) return;

    board[pos] = myRole;
    const isWin = checkWin(board, pos);
    if(isWin){
      room.gameOver = true;
      const winnerName = myRole ===1 ? room.gameInfo.blackName : room.gameInfo.whiteName;
      const loserName = myRole ===1 ? room.gameInfo.whiteName : room.gameInfo.blackName;
      io.to(roomId).emit("gameWin", {winnerRole:myRole, winnerName, loserName, board});
      rooms.delete(roomId);
      io.emit("hallUpdate", getAllRoomList());
    }else{
      room.turn = turn === 1 ? 2 : 1;
      io.to(roomId).emit("boardSync", {board: room.board, turn: room.turn});
    }
  });

  socket.on("disconnect", ()=>{
    console.log("客户端断开", socket.id);
    for(const [rid,room] of rooms.entries()){
      const idx = room.players.indexOf(socket.id);
      if(idx !== -1){
        io.to(rid).emit("playerDisconnect");
        rooms.delete(rid);
        io.emit("hallUpdate", getAllRoomList());
        break;
      }
    }
  })
})

console.log("✅五子棋服务器已启动，监听端口", PORT);

