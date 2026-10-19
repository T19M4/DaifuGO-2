const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// 永続化：DATABASE_URL が設定されていれば PostgreSQL を正本として使用。
// DATABASE_URL がない開発環境では従来どおり accounts.json を使用する。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (err) {
  if (err.code !== 'ENOENT') console.error('accounts.json の読み込みに失敗しました。ファイルを空データで上書きせず起動を停止します。', err);
  if (err.code !== 'ENOENT') throw err;
}
let dbPool = null;
let dbSaveQueue = Promise.resolve();
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render等のマネージドDB接続に対応。DATABASE_SSL=false ならSSLを無効化可能。
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}
const sessions = new Map();
function saveAccounts(){
  const serialized = JSON.stringify(accounts, null, 2);
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, ACCOUNTS_FILE);
  if (dbPool) {
    // 保存を直列化し、同時更新による競合を避ける。
    const snapshot = JSON.parse(serialized);
    dbSaveQueue = dbSaveQueue.then(async () => {
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        const keys = Object.keys(snapshot);
        await client.query('DELETE FROM daifugo_accounts WHERE NOT (username_key = ANY($1::text[]))', [keys]);
        for (const [key, account] of Object.entries(snapshot)) {
          await client.query(
            'INSERT INTO daifugo_accounts (username_key, account_data) VALUES ($1, $2::jsonb) ON CONFLICT (username_key) DO UPDATE SET account_data = EXCLUDED.account_data',
            [key, JSON.stringify(account)]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('PostgreSQLへのアカウント保存に失敗しました:', err);
      } finally { client.release(); }
    }).catch(err => console.error('アカウント保存キューでエラー:', err));
  }
}
async function initializePersistence(){
  if (!dbPool) {
    // ローカルJSON利用時も、読み込みエラーで既存データを空データに置き換えない。
    purgeForbiddenAccounts();
    return;
  }
  await dbPool.query(`CREATE TABLE IF NOT EXISTS daifugo_accounts (
    username_key TEXT PRIMARY KEY,
    account_data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const result = await dbPool.query('SELECT username_key, account_data FROM daifugo_accounts');
  if (result.rows.length > 0) {
    accounts = {};
    for (const row of result.rows) accounts[row.username_key] = row.account_data;
    console.log(`PostgreSQLからアカウント ${result.rows.length} 件を読み込みました。`);
  } else {
    // 初回起動時、既存JSONがあればDBへ移行する。
    const existing = Object.entries(accounts);
    if (existing.length) {
      console.log(`既存 accounts.json から ${existing.length} 件をPostgreSQLへ移行します。`);
      for (const [key, account] of existing) {
        await dbPool.query(
          'INSERT INTO daifugo_accounts (username_key, account_data) VALUES ($1, $2::jsonb) ON CONFLICT (username_key) DO NOTHING',
          [key, JSON.stringify(account)]
        );
      }
      const migrated = await dbPool.query('SELECT username_key, account_data FROM daifugo_accounts');
      accounts = {};
      for (const row of migrated.rows) accounts[row.username_key] = row.account_data;
    }
  }
  purgeForbiddenAccounts();
  saveAccounts();
  await dbSaveQueue;
}
function normalizeUsername(v){ return String(v||'').trim().toLowerCase(); }
function forbiddenDisplayName(v){ const raw=String(v||'').normalize('NFKC').toLowerCase(); const compact=raw.replace(/[\s\u3000]+/g,''); const latinCompact=compact.replace(/[^a-z0-9]/g,''); return ['松村','拓真','小林','裕也','matsumura','takuma','kobayashi','yuya'].some(term=>compact.includes(term)||latinCompact.includes(term)); }
function purgeForbiddenAccounts(){ let changed=false; for(const [key,account] of Object.entries(accounts)){ if(forbiddenDisplayName(account?.username)){ delete accounts[key]; changed=true; } } if(changed)saveAccounts(); return changed; }
function validUsername(v){ return /^[a-zA-Z0-9_]{3,20}$/.test(String(v||'')); }
function hashPassword(password,salt){ return crypto.scryptSync(String(password),salt,64).toString('hex'); }
function safeAccount(a){ return {username:a.username,rp:a.rp||0,games:a.games||0,wins:a.wins||0,ownedTitles:Array.isArray(a.ownedTitles)?a.ownedTitles:[],selectedTitle:a.selectedTitle||''}; }
const GACHA_RARITIES=[{name:'ノーマル',chance:70,titles:['平民の希望','カードの手ほどき','一発逆転の兆し','かけだしのひよっこ','堅実なる手札使い']},{name:'ミドル',chance:24,titles:['場を支配する者','革命の扇動者','縛りの技巧派','切り札の潜伏者','おJJスターバックス⁉','チェックといいなさい']},{name:'ハイスペック',chance:5,titles:['混沌のカードマスター','運命を決める先行チェック','大富豪の覇者','終焉の8切り','不敗のKING']},{name:'レジェンド',chance:1,titles:['これチェックなんだよなぁ','天地開闢の革命','無慈悲なる大富豪','小林裕也を統べし者','伝説のカードエンペラー','Are you ready?']}];
function drawTitle(){const n=Math.random()*100;let rarity=n<70?GACHA_RARITIES[0]:n<94?GACHA_RARITIES[1]:n<99?GACHA_RARITIES[2]:GACHA_RARITIES[3];return {rarity:rarity.name,title:rarity.titles[Math.floor(Math.random()*rarity.titles.length)]};}
function authError(message){ return {ok:false,message}; }
function issueToken(socket,account){ const token=crypto.randomBytes(32).toString('hex'); account.tokenHash=crypto.createHash('sha256').update(token).digest('hex'); saveAccounts(); socket.data.userId=account.id; sessions.set(token,account.id); attemptReconnect(socket,account); return {ok:true,token,account:safeAccount(account)}; }
function accountForSocket(socket){ return Object.values(accounts).find(a=>a.id===socket.data.userId) || null; }
function rankedDelta(playerCount, place){ const table = playerCount===2 ? [200,-200] : playerCount===3 ? [200,0,-200] : playerCount===4 ? [300,200,-200,-300] : [300,200,0,-200,-300]; const value=table[Math.max(0,Math.min(playerCount-1,(place||playerCount)-1))]; return Number.isFinite(value)?value:0; }
function placeLabel(playerCount, place){ if(playerCount===2)return place===1?'上がり！':'負け'; if(playerCount===3)return place<=2?'上がり！':'3位'; if(playerCount===4)return place<=2?'上がり！':place===3?'貧民':'大貧民'; if(playerCount===5)return place<=2?'上がり！':place===3?'3位':place===4?'貧民':'大貧民'; return `${place}位`; }
function awardRankPoints(g){
 if(!g.ranked || g.rankApplied || !g.finished)return;
 g.rankApplied=true;
 const n=g.players.length;
 g.rankResults=[];
 for(const p of g.players){
  const a=p.userId?Object.values(accounts).find(x=>x.id===p.userId):null;
  // 切断・サインアウト時の-400RPはその場で適用済み。終了時に二重加算しない。
  if(p.forfeited){
   g.rankResults.push({name:p.name,place:n,delta:-400,rp:a?(a.rp||0):null,forfeited:true});
   continue;
  }
  const delta=rankedDelta(n,p.place||n);
  if(a){ a.rp=(a.rp||0)+delta; a.games=(a.games||0)+1; if(p.place===1)a.wins=(a.wins||0)+1; g.rankResults.push({name:p.name,place:p.place||n,delta,rp:a.rp}); }
  else { g.rankResults.push({name:p.name,place:p.place||n,delta:0,rp:null}); }
 }
 saveAccounts();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ['https://t19m4.github.io'], methods: ['GET','POST'] } });
const rooms = new Map();
const SUITS = ['♠','♥','♦','♣'];
const RANKS = [3,4,5,6,7,8,9,10,11,12,13,14,15];
const rankName = r => ({11:'J',12:'Q',13:'K',14:'A',15:'2',16:'ジョーカー'}[r] || String(r));
const cardText = c => c.rank === 16 ? 'JOKER' : `${rankName(c.rank)}${c.suit}`;
const shuffle = a => { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const power = (rank,g) => { let p=({3:1,4:2,5:3,6:4,7:5,8:6,9:7,10:8,11:9,12:10,13:11,14:12,15:13,16:14})[rank] || rank; if(g.revolution)p=15-p; if(g.jBack)p=15-p; return p; };
function makeRoomCode(){return crypto.randomBytes(3).toString('hex').toUpperCase();}
function publicPlayers(room){return room.players.map(p=>({name:p.name,title:p.title||'',isCPU:false}));}
function addLog(g,msg){g.logs.push(msg); if(g.logs.length>35)g.logs.shift();}
function active(i,g){return !!g.players[i] && !g.players[i].finished && g.players[i].hand.length>0;}
function nextActive(from,g,steps=1){let i=from; for(let n=0;n<steps;n++){let found=-1; for(let s=1;s<=g.players.length;s++){const j=(i+s)%g.players.length;if(active(j,g)){found=j;break;}} if(found<0)return -1; i=found;} return i;}
function clearTrick(g,start){g.table=[];g.lastCards=[];g.lastPlayer=-1;g.passCount=0;g.lockSuit=null;g.eightPending=false;g.downBase=null;g.effects=[];g.neutralizeCount=0;g.jBack=false;g.jBackNineLock=false;g.trickHistory=[];g.turn=active(start,g)?start:nextActive(start,g); if(g.turn<0)g.finished=true; addLog(g,`場が流れました。${g.players[g.turn]?.name || ''}から再開。Jバックをリセットしました。`);}
// 選択された順番を階段の並びとして扱い、ジョーカーにはその位置の数字を割り当てる。
// 例：[6, Joker, 8] -> [6, 7, 8]。階段でない組み合わせは null。
function stairRanks(cards){
 if(!Array.isArray(cards)||cards.length<3||cards.length>13)return null;
 const normal=cards.filter(c=>c.rank!==16);
 if(!normal.length||!normal.every(c=>c.suit===normal[0].suit))return null;
 const first=cards.findIndex(c=>c.rank!==16);
 const base=cards[first].rank-first;
 const assigned=cards.map((c,i)=>c.rank===16?base+i:c.rank);
 if(assigned.some((r,i)=>r!==base+i||r<3||r>15))return null;
 if(normal.some((c,i)=>normal.some((other,j)=>i!==j&&other.rank===c.rank)))return null;
 return assigned;
}
function validSet(cards){
 if(!cards.length)return false;
 const jokers=cards.filter(c=>c.rank===16),normal=cards.filter(c=>c.rank!==16);
 if(cards.length===1)return true;
 if(normal.length&&normal.every(c=>c.rank===normal[0].rank))return cards.length<=4&&jokers.length<=2;
 if(!normal.length)return cards.length<=2;
 return stairRanks(cards)!==null;
}
function canBeat(cards,g){
 if(!validSet(cards))return false;
 if(g.firstMove)return cards.length===1&&cards[0].rank===3&&cards[0].suit==='♦';
 if(!g.table.length)return true;
 if(g.table.length===1&&cards.length===1&&cards[0].rank===16)return true;
 // 8切りに対する4止め：4を2枚、または4＋ジョーカーのみ。
 if(g.eightPending&&g.table.some(c=>c.rank===8))return cards.length===2&&(cards.every(c=>c.rank===4)||(cards.some(c=>c.rank===4)&&cards.some(c=>c.rank===16)));
 if(cards.length!==g.table.length)return false;
 if(!g.jBackNineLock&&g.table.some(c=>c.rank===16)&&!g.table.some(c=>c.rank===9)&&cards.length===1&&cards[0].rank===3&&cards[0].suit==='♠')return true;
 const playedStair=stairRanks(cards),tableStair=stairRanks(g.table);
 if(playedStair&&tableStair)return power(playedStair[playedStair.length-1],g)>power(tableStair[tableStair.length-1],g);
 if(g.lockSuit&&!cards.some(c=>c.rank===16)&&cards.some(c=>c.suit!==g.lockSuit))return false;
 // ダウンナンバー中はJバックの状態に関係なく、同じスートの前後1つの数字を出せる。
 if(cards.length===1&&g.table.length===1&&cards[0].rank!==16&&g.table[0].rank!==16){
  const adjacent=cards[0].suit===g.table[0].suit&&Math.abs(cards[0].rank-g.table[0].rank)===1;
  if(g.downBase!==null)return adjacent;
  if(adjacent)return true;
 }
 const top=g.table[0].rank;return power(cards[0].rank,g)>power(top,g);
}
function emitGame(code){const room=rooms.get(code);if(!room||!room.game)return;const g=room.game;if(g.finished)awardRankPoints(g);for(const p of room.players){const gp=g.players.find(x=>x.id===p.id);io.to(p.id).emit('onlineGameState',snapshot(g,gp));} }
function snapshot(g,p){return {started:true,finished:g.finished,ranked:!!g.ranked,rankResults:g.rankResults||[],myRank:(p?.userId?Object.values(accounts).find(a=>a.id===p.userId)?.rp:null),players:g.players.map(x=>({name:x.name,title:x.title||'',jokerDisclosure:x.hand.filter(c=>c.rank===16).length>=2,isCPU:x.isCPU,handCount:x.hand.length,finished:x.finished,place:x.place||0,placeLabel:x.place?placeLabel(g.players.length,x.place):''})),myHand:p?p.hand:[],turn:g.turn,table:g.table,lastCards:g.lastCards,lastPlayer:g.lastPlayer,trickHistory:(g.trickHistory||[]).map(x=>({player:x.player,cards:x.cards})),fourStopSerial:g.fourStopSerial||0,jBackSerial:g.jBackSerial||0,revolutionSerial:g.revolutionSerial||0,qBombSerial:g.qBombSerial||0,qBombEvent:g.qBombEvent||null,firstMove:g.firstMove,eightPending:g.eightPending,jBack:g.jBack,jBackNineLock:g.jBackNineLock,revolution:g.revolution,lockSuit:g.lockSuit,downBase:g.downBase,neutralizeCount:g.neutralizeCount,effects:g.effects||[],pendingQ:g.pendingQ?{actor:g.pendingQ.actor,remaining:g.pendingQ.remaining,mine:!!p&&g.players[g.pendingQ.actor]?.id===p.id}:null,pendingChoice:g.pendingChoice?{type:g.pendingChoice.type,remaining:g.pendingChoice.remaining,mine:!!p&&g.players[g.pendingChoice.actor]?.id===p.id,recipientName:g.players[g.pendingChoice.recipient]?.name||''}:null,logs:g.logs,finishOrder:g.finishOrder,notice:g.notice||'',myTurn:!!p&&g.players[g.turn]?.id===p.id&&!g.finished&&!g.pendingQ};}
function broadcastLobby(code){const r=rooms.get(code);if(r)io.to(code).emit('playersUpdated',publicPlayers(r));}
function startGame(code){const room=rooms.get(code);if(!room||(room.game&&!room.game.finished))return;room.game=null;const players=room.players.map(p=>{const a=p.userId?Object.values(accounts).find(x=>x.id===p.userId):null;return {id:p.id,userId:p.userId||null,username:p.username||null,name:p.name,title:a?.selectedTitle||'',isCPU:false,hand:[],finished:false};});const deck=[];for(const s of SUITS)for(const r of RANKS)deck.push({id:`${s}${r}`,suit:s,rank:r});deck.push({id:'joker1',suit:'',rank:16},{id:'joker2',suit:'',rank:16});shuffle(deck);deck.forEach((c,i)=>players[i%players.length].hand.push(c));players.forEach(p=>p.hand.sort((a,b)=>a.rank-b.rank||SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)));const turn=players.findIndex(p=>p.hand.some(c=>c.suit==='♦'&&c.rank===3));room.game={ranked:!!room.ranked,rankApplied:false,rankResults:[],players,turn,table:[],lastCards:[],lastPlayer:-1,passCount:0,firstMove:true,eightPending:false,jBack:false,revolution:false,lockSuit:null,downBase:null,neutralizeCount:0,jBackNineLock:false,pendingQ:null,pendingChoice:null,pendingActions:[],pendingSkip:0,pendingActor:-1,finished:false,finishOrder:[],logs:[],effects:[],trickHistory:[],downSequence:false,fourStopSerial:0,jBackSerial:0,revolutionSerial:0,qBombSerial:0,qBombEvent:null,notice:`ゲーム開始。♦3を持つ${players[turn].name}から開始。`};addLog(room.game,room.game.notice);emitGame(code);}
function finishCheck(g,p){
 if(p.hand.length!==0)return false;
 const n=g.players.length;
 if(p.forfeited){
  // CPU操作中に手札を出し切っても、切断者の順位は最下位のまま。
  p.finished=true;p.place=n;g.finishOrder.push(`${p.name}（切断・最下位）`);addLog(g,`${p.name}は切断ペナルティにより最下位扱いです。`);
 }else{
  const last=g.lastCards||[];const banned=last.some(c=>c.rank===15||c.rank===16);
  if(banned){p.finished=true;p.penaltyFinish=true;p.place=n;g.finishOrder.push(`${p.name}（反則上がり）`);addLog(g,`${p.name}は反則上がり。最下位扱い。`);}
  else{p.finished=true;p.place=g.players.filter(x=>x.finished&&!x.penaltyFinish&&!x.forfeited).length;g.finishOrder.push(p.name);addLog(g,`${p.name}が${p.place}位：${placeLabel(n,p.place)}`);}
 }
 const remaining=g.players.filter(x=>!x.finished);
 if(remaining.length<=1){
  g.finished=true;
  const lastp=remaining[0];
  if(lastp){lastp.finished=true;if(lastp.forfeited||lastp.penaltyFinish)lastp.place=n;else lastp.place=g.players.filter(x=>x.finished&&!x.forfeited&&!x.penaltyFinish).length;g.finishOrder.push(lastp.name);addLog(g,`${lastp.name}は${lastp.place}位：${placeLabel(n,lastp.place)}`);}
  g.players.forEach(x=>{if(!x.place)x.place=n;});
  // 切断者と反則上がりを最後に固定し、それ以外を順位順に表示。
  g.finishOrder=g.players.slice().sort((a,b)=>(a.forfeited||a.penaltyFinish?1:0)-(b.forfeited||b.penaltyFinish?1:0)||(a.place||n)-(b.place||n)).map(x=>`${x.name}（${x.place}位・${placeLabel(n,x.place)}）`);
  addLog(g,'ゲーム終了：'+g.finishOrder.join(' → '));return true;
 }
 return false;
}
function applyQ(code,rank){const room=rooms.get(code),g=room?.game;if(!g||!g.pendingQ)return;const actor=g.pendingQ.actor;let destroyed=0;const destroyedCards=[];for(const p of g.players){for(const c of p.hand){if(c.rank===rank)destroyedCards.push({card:{...c},player:p.name});}const before=p.hand.length;p.hand=p.hand.filter(c=>c.rank!==rank);destroyed+=before-p.hand.length;}g.qBombSerial=(g.qBombSerial||0)+1;g.qBombEvent={serial:g.qBombSerial,rank,destroyedCards};addLog(g,`${g.players[actor].name}のQボンバー：${rankName(rank)}を${destroyed}枚破壊。`);g.pendingQ.remaining--;if(g.pendingQ.remaining>0){g.notice=`Qボンバー：あと${g.pendingQ.remaining}回、数字を選択してください。`;if(g.players[actor].isCPU){setTimeout(()=>applyQ(code,RANKS[Math.floor(Math.random()*RANKS.length)]),500);}else emitGame(code);return;}g.pendingQ=null;runNextPendingAction(code);}
function advanceAfterPlay(code,actor,skip){const room=rooms.get(code),g=room?.game;if(!g)return;if(g.finished){emitGame(code);return;}if(g.table.length&&g.lastCards.length&&g.players[actor].hand.length===0){}const activeCount=g.players.filter((_,i)=>active(i,g)).length;const boundedSkip=Math.min(Math.max(0,skip||0),Math.max(0,activeCount-1));let n=1+boundedSkip;g.turn=nextActive(actor,g,n);if(g.turn<0){g.finished=true;emitGame(code);return;}g.notice=`${g.players[g.turn].name}のターン`;emitGame(code);if(g.players[g.turn].isCPU)setTimeout(()=>cpuTurn(code),900);}
function runNextPendingAction(code){
 const room=rooms.get(code),g=room?.game;if(!g)return;
 if(g.pendingActions&&g.pendingActions.length){
  const action=g.pendingActions.shift();
  if(action.type==='q'){
   g.pendingQ={actor:action.actor,remaining:action.remaining};
   g.notice=`Qボンバー：数字を選択してください（残り${action.remaining}回）。`;
   if(g.players[action.actor]?.isCPU){setTimeout(()=>applyQ(code,RANKS[Math.floor(Math.random()*RANKS.length)]),500);return;}
   emitGame(code);return;
  }
  g.pendingChoice={...action};
  g.notice=action.type==='give'?`7渡し：あと${action.remaining}枚、渡すカードを選んでください。`:`10捨て：あと${action.remaining}枚、捨てるカードを選んでください。`;
  const actor=g.players[action.actor];
  if(actor?.isCPU){
   const chosen=actor.hand.slice().sort((a,b)=>a.rank-b.rank).slice(0,Math.min(action.remaining,actor.hand.length));
   applyOnlineChoice(code,actor.id,chosen.map(c=>c.id));return;
  }
  emitGame(code);return;
 }
 g.pendingChoice=null;
 const actorIndex=g.pendingActor;
 const actor=g.players[actorIndex];
 if(actor&&finishCheck(g,actor)){emitGame(code);return;}
 const skip=g.pendingSkip||0;g.pendingSkip=0;g.pendingActor=-1;
 advanceAfterPlay(code,actorIndex,skip);
}
function applyOnlineChoice(code,playerId,ids,expectedType=null){
 const room=rooms.get(code),g=room?.game,choice=g?.pendingChoice;if(!g||!choice)return {ok:false,message:'カード選択中ではありません。'};
 const actor=g.players[choice.actor];if(!actor||actor.id!==playerId)return {ok:false,message:'カードを選択できるプレイヤーではありません。'};
 if(expectedType&&choice.type!==expectedType)return {ok:false,message:expectedType==='give'?'現在は「相手に渡す」処理ではありません。':'現在は「カードを捨てる」処理ではありません。'};
 const wanted=new Set(Array.isArray(ids)?ids:[]);const cards=actor.hand.filter(c=>wanted.has(c.id));
 const need=Math.min(choice.remaining,actor.hand.length);
 if(cards.length!==wanted.size||cards.length!==need){return {ok:false,message:`カードを${need}枚選択してください。`};}
 if(choice.type==='give'&&!g.players[choice.recipient])return {ok:false,message:'渡す相手が見つかりません。'};
 actor.hand=actor.hand.filter(c=>!wanted.has(c.id));
 if(choice.type==='give'){
  const recipient=g.players[choice.recipient];recipient.hand.push(...cards);recipient.hand.sort((a,b)=>a.rank-b.rank||SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit));
 }else{
  addLog(g,`${actor.name}が10捨てで${cards.map(cardText).join('・')}を捨てた。`);
 }
 g.pendingChoice=null;
 runNextPendingAction(code);
 return {ok:true};
}
function doPlay(code,playerId,ids){
 const room=rooms.get(code),g=room?.game;if(!g||g.finished||g.pendingQ||g.pendingChoice)return;
 const p=g.players[g.turn];if(!p||p.id!==playerId||p.isCPU)return;
 const orderedIds=Array.isArray(ids)?ids:[];const wanted=new Set(orderedIds);const cards=orderedIds.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean);
 if(cards.length!==wanted.size||!cards.length||!canBeat(cards,g)){io.to(playerId).emit('onlineActionError','そのカードは出せません。');return;}
 const oldTable=g.table.slice(),wasOccupied=oldTable.length>0;
 const fourStop=g.eightPending&&oldTable.some(c=>c.rank===8)&&cards.length===2&&(cards.every(c=>c.rank===4)||(cards.some(c=>c.rank===4)&&cards.some(c=>c.rank===16)));
 const qToJBack=oldTable.length===1&&cards.length===1&&oldTable[0].rank===12&&cards[0].rank===11&&cards[0].suit===oldTable[0].suit;
 const down=!qToJBack&&oldTable.length===1&&cards.length===1&&cards[0].rank!==16&&oldTable[0].rank!==16&&cards[0].suit===oldTable[0].suit&&Math.abs(cards[0].rank-oldTable[0].rank)===1;
 const oldLock=g.lockSuit,selectedStairRanks=stairRanks(cards),effectiveRanks=selectedStairRanks||cards.map(c=>c.rank),jPlayedEarlier=g.trickHistory.some(x=>(x.effectiveRanks||x.cards.map(c=>c.rank)).includes(11));
 p.hand=p.hand.filter(c=>!wanted.has(c.id));g.table=cards;g.lastCards=cards;g.lastPlayer=g.turn;g.passCount=0;g.firstMove=false;g.downBase=down?(g.downBase!==null?g.downBase:oldTable[0].rank):null;g.trickHistory.push({player:p.name,cards:cards.slice(),effectiveRanks:effectiveRanks.slice()});
 if(wasOccupied&&oldTable.length&&cards.every(c=>c.suit&&c.suit===cards[0].suit)&&oldTable.every(c=>c.suit&&c.suit===oldTable[0].suit)&&cards[0].suit===oldTable[0].suit)g.lockSuit=cards[0].suit;else if(!wasOccupied)g.lockSuit=null;else g.lockSuit=oldLock&&cards.every(c=>c.suit===oldLock)?oldLock:null;
 addLog(g,`${p.name}：${cards.map(cardText).join(' ')}`);if(qToJBack)addLog(g,'QのあとにJ：ダウンナンバーを解除し、Jバックを発動します。');else if(down)addLog(g,'ダウンナンバー！');
 if(!g.jBackNineLock&&g.jBack&&jPlayedEarlier&&effectiveRanks.includes(9)){g.jBackNineLock=true;addLog(g,'Jバック＋9：Jバックは維持。以降の特殊効果を場が流れるまで封印。');}
 let skip=0;const suppress=g.neutralizeCount>0||g.jBackNineLock;if(g.neutralizeCount>0)g.neutralizeCount--;
 if(fourStop){g.effects.push('4止め');g.fourStopSerial=(g.fourStopSerial||0)+1;addLog(g,`止め価値あり！ ${p.name}が4止め！場を流し、${p.name}から再開します。`);if(finishCheck(g,p)){emitGame(code);return;}clearTrick(g,g.turn);g.notice='止め価値あり！ '+p.name+'から再開します。';emitGame(code);if(g.players[g.turn]?.isCPU)setTimeout(()=>cpuTurn(code),900);return;}
 g.pendingActions=[];g.pendingActor=g.turn;g.pendingSkip=0;
 if(!suppress){
  const staircaseRanks=selectedStairRanks;
  // 階段中のジョーカーは、選択順で補った数字の効果も発動する。
  // 例：[6, Joker, 8] は7を含むため7渡し1枚が発動。
  const jokerSub=cards.some(c=>c.rank===16)&&cards.some(c=>c.rank!==16)?1:0;
  const count=r=>staircaseRanks
   ? staircaseRanks.filter(rank=>rank===r).length
   : cards.filter(c=>c.rank===r).length+(jokerSub&&cards.some(c=>c.rank===r)?1:0);
  skip=count(5);if(skip)g.effects.push(`5スキップ（${skip}回）`);
  const give=count(7);if(give){g.effects.push(`7渡し（${give}枚）`);const recipient=nextActive(g.turn,g),remaining=Math.min(give,p.hand.length);if(remaining>0&&recipient>=0)g.pendingActions.push({type:'give',actor:g.turn,recipient,remaining});}
  if(count(8)>0){g.effects.push(`8切り（${count(8)}枚）`);g.eightPending=true;addLog(g,'8切り：4止めの機会です。');}
  if(count(9)>0){g.effects.push('9能力無効化');g.neutralizeCount=Math.max(g.neutralizeCount,count(9));addLog(g,`9の効果：次の${g.neutralizeCount}回の特殊効果を無効化。`);}
  const discard=count(10);if(discard){g.effects.push(`10捨て（${discard}枚）`);const remaining=Math.min(discard,p.hand.length);if(remaining>0)g.pendingActions.push({type:'discard',actor:g.turn,remaining});}
  // ダウンナンバーでJを出した場合も、通常どおりJバックを発動する。
  const js=count(11);const hasNineUnderJ=oldTable.some(c=>c.rank===9);const triggerJBack=js>0&&!hasNineUnderJ;if(triggerJBack)g.effects.push(`Jバック（Jを${js}枚出し・効果1回）`);if(triggerJBack){g.jBack=!g.jBack;g.jBackSerial=(g.jBackSerial||0)+1;addLog(g,`Jバック発動（Jを${js}枚出し）。`);}
  const normal=cards.filter(c=>c.rank!==16),jokerCount=cards.filter(c=>c.rank===16).length;
  const sameRankRevolution=cards.length===4&&normal.length>0&&normal.every(c=>c.rank===normal[0].rank)&&jokerCount<=2;
  const stairRevolution=!!staircaseRanks&&cards.length>=4;
  if(sameRankRevolution||stairRevolution){g.revolution=!g.revolution;g.revolutionSerial=(g.revolutionSerial||0)+1;g.effects.push(g.revolution?'革命':'革命返し');addLog(g,g.revolution?'革命！':'革命返し！');}
  const qs=count(12);if(qs){g.effects.push(`Qボンバー（${qs}回）`);g.pendingActions.push({type:'q',actor:g.turn,remaining:qs});}
 }
 if(!g.jBackNineLock&&cards.length===1&&cards[0].rank===3&&cards[0].suit==='♠'&&oldTable.some(c=>c.rank===16)&&!oldTable.some(c=>c.rank===9)){addLog(g,'♠3返し！');clearTrick(g,g.turn);emitGame(code);if(g.players[g.turn]?.isCPU)setTimeout(()=>cpuTurn(code),900);return;}
 g.pendingSkip=skip;
 if(g.pendingActions.length){runNextPendingAction(code);return;}
 if(finishCheck(g,p)){emitGame(code);return;}
 advanceAfterPlay(code,g.turn,skip);
}
function doPass(code,playerId){const room=rooms.get(code),g=room?.game;if(!g||g.finished||g.pendingQ||g.pendingChoice)return;const p=g.players[g.turn];if(!p||p.id!==playerId||p.isCPU)return;if(g.firstMove||!g.table.length)return;addLog(g,`${p.name}はパス。`);if(g.eightPending){clearTrick(g,g.lastPlayer>=0?g.lastPlayer:g.turn);emitGame(code);if(g.players[g.turn]?.isCPU)setTimeout(()=>cpuTurn(code),900);return;}g.passCount++;const activeCount=g.players.filter((_,i)=>active(i,g)).length;if(g.passCount>=Math.max(1,activeCount-1)){clearTrick(g,g.lastPlayer>=0?g.lastPlayer:g.turn);emitGame(code);if(g.players[g.turn]?.isCPU)setTimeout(()=>cpuTurn(code),900);return;}g.turn=nextActive(g.turn,g);emitGame(code);if(g.players[g.turn]?.isCPU)setTimeout(()=>cpuTurn(code),900);}
function cpuCardPriority(cards){
 // まず中位札を使い、3・4・6の温存を優先。A(1)・2・ジョーカーはさらに温存する。
 const rank = cards.find(c=>c.rank!==16)?.rank ?? 16;
 if ([5,7,8,9,10,11,12,13].includes(rank)) return 0;
 if ([3,4,6].includes(rank)) return 1;
 if (rank===14) return 2; // A（1）
 if (rank===15) return 3; // 2
 if (cards.some(c=>c.rank===16)) return 4; // ジョーカー
 return 5;
}
function cpuChoose(p,g){
 if(g.firstMove){const c=p.hand.find(c=>c.suit==='♦'&&c.rank===3);return c?[c]:[];}
 // 場札がジョーカー1枚だけなら、♠3返しを90%で狙う。
 if(g.table.length===1&&g.table[0].rank===16&&p.hand.some(c=>c.rank===3&&c.suit==='♠')&&Math.random()<0.9){
   const spadeThree=p.hand.find(c=>c.rank===3&&c.suit==='♠');
   if(canBeat([spadeThree],g)) return [spadeThree];
 }
 const groups=new Map();
 for(const c of p.hand){const key=c.rank===16?'joker':String(c.rank);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
 const options=[];
 if(g.table.length>=3){for(const suit of SUITS){const arr=p.hand.filter(c=>c.suit===suit&&c.rank!==16).sort((a,b)=>a.rank-b.rank);for(let i=0;i<arr.length;i++){const run=[arr[i]];for(let j=i+1;j<arr.length;j++){if(arr[j].rank===run[run.length-1].rank+1)run.push(arr[j]);else if(arr[j].rank>run[run.length-1].rank+1)break;if(run.length===g.table.length&&canBeat(run,g))options.push(run.slice());}}}}
 for(const group of groups.values()){for(let n=1;n<=Math.min(group.length,g.table.length||1);n++){if(n!==(g.table.length||1))continue;const combo=group.slice(0,n);if(canBeat(combo,g))options.push(combo);}}
 if(g.eightPending){
   const fours=p.hand.filter(c=>c.rank===4);
   const joker=p.hand.find(c=>c.rank===16);
   let stop=null;
   if(fours.length>=2&&canBeat(fours.slice(0,2),g))stop=fours.slice(0,2);
   else if(fours.length&&joker&&canBeat([fours[0],joker],g))stop=[fours[0],joker];
   // 4止めを成立可能な場面でも実行率は40%。残り60%はパスする。
   if(stop&&Math.random()<0.4)return stop;
   return [];
 }
 if(!options.length)return [];
 // ジョーカー/A/2をできるだけ温存し、3・4・6からも先に出さない。
 options.sort((a,b)=>cpuCardPriority(a)-cpuCardPriority(b)||power(a[0].rank,g)-power(b[0].rank,g)||a.length-b.length);
 return options[0]||[];
}
function cpuTurn(code){const room=rooms.get(code),g=room?.game;if(!g||g.finished||g.pendingQ||!g.players[g.turn]?.isCPU)return;const p=g.players[g.turn];const cards=cpuChoose(p,g);if(cards.length)doPlay(code,p.id,cards.map(c=>c.id));else doPass(code,p.id);}
function attemptReconnect(socket, account){
 if(!account?.id)return false;
 for(const [code,room] of rooms.entries()){
  const g=room.game;
  if(!g||g.finished)continue;
  const index=g.players.findIndex(p=>p.userId===account.id && p.disconnected && !p.forfeited && !p.finished);
  if(index<0)continue;
  const gp=g.players[index];
  if(gp.reconnectTimer){clearTimeout(gp.reconnectTimer);gp.reconnectTimer=null;}
  gp.disconnected=false;
  gp.disconnectedAt=null;
  gp.id=socket.id;
  gp.isCPU=false;
  gp.name=gp.name.replace(/（接続待ち）$/,'');
  const roomPlayer=room.players.find(p=>p.userId===account.id);
  if(roomPlayer){roomPlayer.id=socket.id;roomPlayer.name=gp.name;roomPlayer.title=gp.title||'';}
  socket.join(code);
  socket.data.roomCode=code;
  addLog(g,`${gp.name}が1分以内に復帰しました。対戦を再開します。`);
  if(g.turn===index)g.notice=`${gp.name}が復帰しました。${gp.name}のターンです。`;
  else g.notice=`${gp.name}が復帰しました。対戦を続行します。`;
  broadcastLobby(code);
  emitGame(code);
  return true;
 }
 return false;
}
function applyDisconnectPenalty(code,index){
 const room=rooms.get(code),g=room?.game;
 if(!room||!g||g.finished)return;
 const gp=g.players[index];
 if(!gp||!gp.disconnected||gp.forfeited||gp.finished)return;
 gp.reconnectTimer=null;
 gp.forfeited=true;
 gp.finished=true;
 gp.place=g.players.length;
 gp.hand=[];
 gp.isCPU=false;
 gp.disconnected=false;
 if(!gp.name.includes('（退出）'))gp.name += '（退出）';
 const account=gp.userId?Object.values(accounts).find(a=>a.id===gp.userId):null;
 if(account){account.rp=(account.rp||0)-400;account.games=(account.games||0)+1;gp.forfeitRpApplied=true;saveAccounts();}
 addLog(g,`${gp.name}は1分以内に復帰しなかったため、最下位・-400RPの退出ペナルティが適用されました。`);
 const wasTurn=g.turn===index;
 const wasPendingActor=g.pendingQ?.actor===index||g.pendingChoice?.actor===index||g.pendingActor===index;
 if(wasPendingActor){g.pendingQ=null;g.pendingChoice=null;g.pendingActions=[];g.pendingSkip=0;g.pendingActor=-1;}
 if(wasTurn||wasPendingActor){
  const next=nextActive(index,g);
  if(next>=0){g.turn=next;g.notice=`${g.players[g.turn].name}のターン（退出者は最下位扱い）`;}
  else g.finished=true;
 }
 const remaining=g.players.filter(x=>!x.finished);
 if(!g.finished&&remaining.length<=1){
  g.finished=true;
  const lastp=remaining[0];
  if(lastp){lastp.finished=true;lastp.place=g.players.filter(x=>x.finished&&!x.forfeited&&!x.penaltyFinish).length; if(lastp.forfeited||lastp.penaltyFinish)lastp.place=g.players.length;addLog(g,`${lastp.name}は${lastp.place}位：${placeLabel(g.players.length,lastp.place)}`);}
  g.players.forEach(x=>{if(!x.place)x.place=g.players.length;});
  g.finishOrder=g.players.slice().sort((a,b)=>(a.forfeited||a.penaltyFinish?1:0)-(b.forfeited||b.penaltyFinish?1:0)||(a.place||g.players.length)-(b.place||g.players.length)).map(x=>`${x.name}（${x.place}位・${placeLabel(g.players.length,x.place)}）`);
  addLog(g,'ゲーム終了：'+g.finishOrder.join(' → '));
 }
 emitGame(code);
}
function leaveRoom(socket){
 const code=socket.data.roomCode;if(!code)return;
 const room=rooms.get(code);socket.leave(code);socket.data.roomCode=null;if(!room)return;
 const g=room.game;
 if(g&&!g.finished){
  const index=g.players.findIndex(p=>p.id===socket.id);
  const gp=index>=0?g.players[index]:null;
  if(gp&&!gp.finished&&!gp.forfeited&&!gp.disconnected){
   gp.disconnected=true;gp.isCPU=false;gp.disconnectedAt=Date.now();
   if(!gp.name.endsWith('（接続待ち）'))gp.name+='（接続待ち）';
   addLog(g,`${gp.name}が切断されました。60秒以内に復帰しなければ最下位・-400RPとなります。CPUによる代打は行いません。`);
   g.notice=`${gp.name}の復帰待ち（残り60秒）。CPU代打は行いません。`;
   gp.reconnectTimer=setTimeout(()=>applyDisconnectPenalty(code,index),60000);
   if(room.hostId===socket.id){const nextHost=room.players.find(p=>p.id!==socket.id);if(nextHost)room.hostId=nextHost.id;}
   emitGame(code);
   broadcastLobby(code);
   return; // 試合中の席は60秒間保持して再接続を待つ
  }
 }
 room.players=room.players.filter(p=>p.id!==socket.id);
 if(!room.players.length){rooms.delete(code);return;}
 if(room.hostId===socket.id)room.hostId=room.players[0].id;
 broadcastLobby(code);
}
app.get('/',(_req,res)=>res.send('DaifuGO-2 online server is running.'));
io.on('connection',socket=>{
 socket.on('authRegister',(payload={},cb)=>{const username=String(payload.username||'').trim();const key=normalizeUsername(username);const password=String(payload.password||'');if(!validUsername(username))return cb?.(authError('ユーザー名は英数字と_で3〜20文字にしてください。'));if(forbiddenDisplayName(username))return cb?.(authError('このユーザー名は使用できません。禁止ワードが含まれています。'));if(password.length<8||password.length>128)return cb?.(authError('パスワードは8〜128文字にしてください。'));if(accounts[key])return cb?.(authError('そのユーザー名はすでに使われています。'));const salt=crypto.randomBytes(16).toString('hex');const a={id:crypto.randomUUID(),username,salt,passwordHash:hashPassword(password,salt),rp:0,games:0,wins:0,ownedTitles:[],selectedTitle:'',tokenHash:null};accounts[key]=a;const result=issueToken(socket,a);cb?.(result);});
 socket.on('authLogin',(payload={},cb)=>{purgeForbiddenAccounts();const username=String(payload.username||'').trim(),key=normalizeUsername(username),password=String(payload.password||''),a=accounts[key];if(!a)return cb?.(authError('ユーザー名またはパスワードが違います。'));if(forbiddenDisplayName(a.username)){delete accounts[key];saveAccounts();return cb?.(authError('このアカウントは利用できません。'));}const candidate=Buffer.from(hashPassword(password,a.salt),'hex');const stored=Buffer.from(a.passwordHash,'hex');if(candidate.length!==stored.length||!crypto.timingSafeEqual(candidate,stored))return cb?.(authError('ユーザー名またはパスワードが違います。'));cb?.(issueToken(socket,a));});
 socket.on('authResume',(payload={},cb)=>{purgeForbiddenAccounts();const token=String(payload.token||'');if(!/^[a-f0-9]{64}$/.test(token))return cb?.(authError('ログイン情報が無効です。'));const hash=crypto.createHash('sha256').update(token).digest('hex');const a=Object.values(accounts).find(x=>x.tokenHash===hash);if(!a)return cb?.(authError('ログイン情報の期限が切れています。もう一度ログインしてください。'));socket.data.userId=a.id;sessions.set(token,a.id);attemptReconnect(socket,a);cb?.({ok:true,account:safeAccount(a)});});
 socket.on('authLogout',(_payload,cb)=>{const a=accountForSocket(socket);if(a){a.tokenHash=null;saveAccounts();}leaveRoom(socket);socket.data.userId=null;cb?.({ok:true});});
 socket.on('rollTitleGacha',(payload={},cb)=>{const a=accountForSocket(socket);if(!a)return cb?.(authError('ガチャを回すにはログインしてください。'));const count=Number(payload.count);if(count!==1&&count!==10)return cb?.({ok:false,message:'1連または10連を選択してください。'});const cost=count===1?200:900;if((a.rp||0)<cost)return cb?.({ok:false,message:`RPが足りません（必要：${cost} RP）。`});a.rp=(a.rp||0)-cost;if(!Array.isArray(a.ownedTitles))a.ownedTitles=[];const results=[];for(let i=0;i<count;i++){const draw=drawTitle(),duplicate=a.ownedTitles.includes(draw.title);if(!duplicate)a.ownedTitles.push(draw.title);results.push({...draw,duplicate});}saveAccounts();cb?.({ok:true,spent:cost,results,account:safeAccount(a)});});
 socket.on('setSelectedTitle',(payload={},cb)=>{const a=accountForSocket(socket);if(!a)return cb?.(authError('称号を設定するにはログインしてください。'));const title=String(payload.title||'');if(title&&!(Array.isArray(a.ownedTitles)&&a.ownedTitles.includes(title)))return cb?.({ok:false,message:'その称号は所持していません。ガチャで獲得してください。'});a.selectedTitle=title;for(const [code,room] of rooms.entries()){let changed=false;for(const p of room.players){if(p.userId===a.id){p.title=title;changed=true;}}if(room.game){for(const gp of room.game.players){if(gp.userId===a.id){gp.title=title;changed=true;}}}if(changed){broadcastLobby(code);if(room.game)emitGame(code);}}saveAccounts();cb?.({ok:true,account:safeAccount(a)});});
 socket.on('getLeaderboard',(_payload,cb)=>{purgeForbiddenAccounts();const list=Object.values(accounts).map(safeAccount).sort((a,b)=>b.rp-a.rp||b.wins-a.wins).slice(0,50);cb?.({ok:true,players:list});});
 socket.on('createRoom',(payload={},cb)=>{const rawName=String(payload.name||'').trim();if(!rawName)return cb?.({ok:false,message:'表示名を入力してください。'});if(forbiddenDisplayName(rawName))return cb?.({ok:false,message:'この名前はオンライン対戦で使用できません。別の名前を入力してください。'});const name=rawName.slice(0,6);const ranked=true;const account=accountForSocket(socket);if(!account)return cb?.(authError('オンライン対戦はランク戦のみです。先にログインしてください。'));leaveRoom(socket);let code;do{code=makeRoomCode();}while(rooms.has(code));const maxPlayers=Math.max(2,Math.min(5,Number.parseInt(payload.maxPlayers,10)||4));const room={hostId:socket.id,maxPlayers,ranked,players:[{id:socket.id,name,title:account?.selectedTitle||'',userId:account?.id||null,username:account?.username||null}],game:null};rooms.set(code,room);socket.join(code);socket.data.roomCode=code;cb?.({ok:true,roomCode:code,isHost:true,maxPlayers,ranked,players:publicPlayers(room)});});
 socket.on('joinRoom',(payload={},cb)=>{const code=String(payload.roomCode||'').trim().toUpperCase(),rawName=String(payload.name||'').trim(),room=rooms.get(code),account=accountForSocket(socket);if(!rawName)return cb?.({ok:false,message:'表示名を入力してください。'});if(forbiddenDisplayName(rawName))return cb?.({ok:false,message:'この名前はオンライン対戦で使用できません。別の名前を入力してください。'});const name=rawName.slice(0,6);if(!room)return cb?.({ok:false,message:'部屋が見つかりません。'});if(!room.ranked)return cb?.({ok:false,message:'オンライン対戦はランク戦のみです。新しいルームを作成してください。'});if(!account)return cb?.(authError('オンライン対戦はランク戦のみです。ログインしてください。'));if(room.ranked&&room.players.some(p=>p.userId===account?.id))return cb?.(authError('同じアカウントで複数参加できません。'));if(room.game)return cb?.({ok:false,message:'ゲーム開始後は参加できません。'});if(room.players.length>=room.maxPlayers)return cb?.({ok:false,message:'この部屋は満員です。'});leaveRoom(socket);room.players.push({id:socket.id,name,title:account?.selectedTitle||'',userId:account?.id||null,username:account?.username||null});socket.join(code);socket.data.roomCode=code;broadcastLobby(code);cb?.({ok:true,roomCode:code,isHost:false,maxPlayers:room.maxPlayers,ranked:!!room.ranked,players:publicPlayers(room)});});
 socket.on('startOnlineGame',(_payload,cb)=>{const code=socket.data.roomCode,room=rooms.get(code);if(!room)return cb?.({ok:false,message:'先にルームへ参加してください。'});if(room.hostId!==socket.id)return cb?.({ok:false,message:'ゲーム開始はルーム作成者のみ実行できます。'});if(room.game&&!room.game.finished)return cb?.({ok:false,message:'ゲームはすでに進行中です。'});if(room.players.length!==room.maxPlayers)return cb?.({ok:false,message:`参加人数が足りません（${room.players.length}/${room.maxPlayers}人）。`});if(room.ranked&&room.players.some(p=>!p.userId))return cb?.({ok:false,message:'ランク戦の参加者全員がログインする必要があります。'});startGame(code);cb?.({ok:true});});
 socket.on('onlinePlay',(payload={},cb)=>{const code=socket.data.roomCode;if(!code)return cb?.({ok:false,message:'ルームに参加していません。'});doPlay(code,socket.id,payload.cardIds||[]);cb?.({ok:true});});
 socket.on('onlinePass',(_payload,cb)=>{const code=socket.data.roomCode;if(!code)return cb?.({ok:false,message:'ルームに参加していません。'});doPass(code,socket.id);cb?.({ok:true});});
 const handleChoiceCommand=(expectedType,payload={},cb)=>{const code=socket.data.roomCode;if(!code)return cb?.({ok:false,message:'ルームに参加していません。'});const room=rooms.get(code),g=room?.game;if(!g?.pendingChoice||g.players[g.pendingChoice.actor]?.id!==socket.id)return cb?.({ok:false,message:'カード選択中ではありません。'});const result=applyOnlineChoice(code,socket.id,payload.cardIds||[],expectedType);cb?.(result);};
 socket.on('onlineChooseCards',(payload={},cb)=>handleChoiceCommand(null,payload,cb));
 socket.on('onlineGiveCards',(payload={},cb)=>handleChoiceCommand('give',payload,cb));
 socket.on('onlineDiscardCards',(payload={},cb)=>handleChoiceCommand('discard',payload,cb));
 socket.on('onlineQSelect',(payload={},cb)=>{const code=socket.data.roomCode,room=rooms.get(code),g=room?.game;if(!g||!g.pendingQ||g.players[g.pendingQ.actor]?.id!==socket.id)return cb?.({ok:false,message:'Qボンバーの選択状態ではありません。'});const rank=Number(payload.rank);if(!RANKS.includes(rank)&&rank!==16)return cb?.({ok:false,message:'数字を選択してください。'});applyQ(code,rank);cb?.({ok:true});});
 socket.on('leaveRoom',cb=>{leaveRoom(socket);cb?.({ok:true});});socket.on('disconnect',()=>leaveRoom(socket));
});
const PORT=process.env.PORT||3000;
initializePersistence().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`Server listening on port ${PORT}${dbPool?' (PostgreSQL persistence enabled)':''}`))).catch(err=>{console.error('永続データの初期化に失敗したため、サーバー起動を中止しました。',err);process.exit(1);});
