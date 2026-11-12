/* ═══════════════════════════════════════════════════════════════════════════
   accounts.js — регистрация / вход / таблицы лидеров (Supabase)
   Подключается из index.html ТЕГОМ <script src="accounts.js"></script>
   Рядом должен лежать supabase_setup.sql (таблицы в базе Supabase).

   КАК ЭТОТ ФАЙЛ СВЯЗАН С ИГРОЙ (index.html)
   ─────────────────────────────────────────
   Игра и этот файл НЕ вызывают друг друга напрямую, общаются через «мост»,
   который создан в index.html (объекты GameEvents и GameAPI):

     index.html (игра)                                   accounts.js
     ─────────────────                                   ───────────
     start()          ── GameEvents.emit('game:start')  ─►  сбросить счётчик/результат
     ход белых        ── GameEvents.emit('game:move')   ─►  запомнить число ходов
     победа белых     ── GameEvents.emit('game:win')    ─►  записать результат в Supabase
     экран победы     ◄─ GameAPI.showResultNote(текст)  ──  «✅ записано» / «войди в аккаунт»

   Что передаёт игра:  game:start {teams, shape}
                       game:move  {moves}
                       game:win   {moves, teams, shape}
   Места связи в этом файле помечены:  ◄── СВЯЗЬ С ИГРОЙ

   Если убрать этот файл, игра продолжит работать (просто без аккаунтов).
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

// Публичный (publishable) ключ проекта; секретный service_role сюда вставлять нельзя
const SB_URL_DEFAULT='https://wlirbdneulstqsjburjh.supabase.co';
const SB_URL_RE=/^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
function sbNormUrl(u){
  u=(u||'').trim().replace(/\/+$/,'');
  if(!u)return '';
  const dm=u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]{20})/i);   // ссылка на дашборд → берём id проекта
  if(dm)u=dm[1];
  if(/^[a-z0-9]{20}$/i.test(u))u='https://'+u+'.supabase.co';
  else if(!/^https?:\/\//i.test(u))u='https://'+u;
  u=u.replace(/^http:\/\//i,'https://');
  return SB_URL_RE.test(u)?u:null;      // null — не похоже на адрес проекта
}
function sbUrl(){
  let u='';try{u=localStorage.getItem('sb_url')||'';}catch(e){}
  return sbNormUrl(u)||SB_URL_DEFAULT;     // испорченное сохранённое значение игнорируем
}
function sbSetUrl(v){
  const n=sbNormUrl(v);
  if(n===null)return false;
  try{if(n)localStorage.setItem('sb_url',n);else localStorage.removeItem('sb_url');}catch(e){}
  sbSave(null);return true;
}
let curMoves=0,pendingResult=null,resultSent=false,sbSession=null,openAcc=null,acctStats=null;
// Публичный (publishable) ключ проекта; секретный service_role сюда вставлять нельзя
const SB_KEY='sb_publishable_l5GduuCh5WB5DI5ecqAc-g_HjGZK802';
const sbOk=()=>!!SB_KEY&&!/PASTE/.test(SB_KEY);
try{sbSession=JSON.parse(localStorage.getItem('sb_session')||'null');}catch(e){}
try{openAcc=JSON.parse(localStorage.getItem('sb_open')||'null');}catch(e){}
function sbSave(s){sbSession=s;try{if(s)localStorage.setItem('sb_session',JSON.stringify(s));else localStorage.removeItem('sb_session');}catch(e){}}
function openSave(o){openAcc=o;try{if(o)localStorage.setItem('sb_open',JSON.stringify(o));else localStorage.removeItem('sb_open');}catch(e){}}
const isLogged=()=>!!(sbSession||openAcc);

async function sbFetch(path,opts,token){
  opts=opts||{};
  const h=Object.assign({apikey:SB_KEY,'Content-Type':'application/json'},opts.headers||{});
  if(token)h.Authorization='Bearer '+token;   // publishable-ключ — не JWT, в Authorization отправляем только токен пользователя
  let r;
  try{r=await fetch(sbUrl()+path,Object.assign({},opts,{headers:h}));}
  catch(e){throw new Error('Нет связи с Supabase ('+sbUrl().replace(/^https?:\/\//,'')+'). Проверь интернет и попробуй ещё раз.');}
  let j=null;try{j=await r.json();}catch(e){}
  if(!r.ok){
    let m=(j&&(j.msg||j.message||j.error_description||j.error))||('Ошибка '+r.status);
    const L=[
      [/invalid login credentials/i,'Неверный email или пароль (или email ещё не подтверждён)'],
      [/email not confirmed/i,'Email не подтверждён: открой ссылку из письма (проверь «Спам»)'],
      [/rate limit|too many/i,'Слишком много попыток или писем. Подожди или отключи подтверждение email в Supabase'],
      [/already registered|already been registered/i,'Этот email уже зарегистрирован — нажми «У меня есть аккаунт» и войди'],
      [/password should be at least/i,'Пароль слишком короткий (минимум 6 символов)'],
      [/different from the old password/i,'Новый пароль должен отличаться от старого'],
      [/otp_expired|token has expired|expired or is invalid|session missing|invalid jwt/i,'Ссылка из письма устарела или уже использована — запроси новую через «Забыл пароль?»'],
      [/duplicate key|23505/i,'Такой ник уже занят'],
      [/row-level security|42501/i,'Нет прав записи — запусти обновлённый supabase_setup.sql в Supabase'],
      [/relation .* does not exist|could not find the table|PGRST205|PGRST202/i,'В базе нет нужных таблиц — запусти supabase_setup.sql в Supabase'],
      [/invalid api key|apikey/i,'Неверный ключ Supabase']
    ];
    for(const [re,t] of L)if(re.test(m)){m=t;break;}
    throw new Error(m);
  }
  return j;
}
function sbMakeSession(j){
  if(!j||!j.access_token)return null;
  return {access_token:j.access_token,refresh_token:j.refresh_token,expires_at:j.expires_at||(Math.floor(Date.now()/1000)+(j.expires_in||3600)),user:j.user};
}
async function sbToken(){
  if(!sbSession)return null;
  if(sbSession.expires_at-60<Date.now()/1000){
    try{
      const j=await sbFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:sbSession.refresh_token})});
      const s=sbMakeSession(j);if(s)sbSave(s);else{sbSave(null);return null;}
    }catch(e){sbSave(null);return null;}
  }
  return sbSession.access_token;
}
// Куда Supabase перекинет по ссылке из письма (подтверждение почты / сброс пароля).
// Впиши адрес страницы auth.html после выкладки в интернет, например 'https://мой-сайт.netlify.app/auth.html'.
// Пусто — Supabase использует Site URL из настроек проекта.
const AUTH_PAGE_URL='https://darkstalke5r.github.io/ChessRandom/auth.html';
function authBack(){return AUTH_PAGE_URL?'?redirect_to='+encodeURIComponent(AUTH_PAGE_URL):'';}
function sbNick(){
  if(sbSession){const u=sbSession.user;return (u&&u.user_metadata&&u.user_metadata.nickname)||((u&&u.email)||'').split('@')[0];}
  return openAcc?openAcc.nickname:'';
}
// --- обычный аккаунт (email + пароль) ---
async function sbSignUp(email,password,nick){
  const back=authBack();
  const j=await sbFetch('/auth/v1/signup'+back,{method:'POST',body:JSON.stringify({email,password,data:{nickname:nick}})});
  const s=sbMakeSession(j);
  if(s){openSave(null);sbSave(s);return 'ok';}
  // при включённом подтверждении почты Supabase на уже занятый email отвечает «успехом», но с пустым identities
  const u=(j&&j.user)||j;
  if(u&&Array.isArray(u.identities)&&u.identities.length===0)throw new Error('Этот email уже зарегистрирован — нажми «У меня есть аккаунт» и войди');
  return 'confirm';
}
async function sbSignIn(email,password){
  const j=await sbFetch('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
  const s=sbMakeSession(j);if(!s)throw new Error('Не удалось войти');openSave(null);sbSave(s);
}
// --- открытый аккаунт (только ник, без пароля и почты) ---
function nickOk(n){return n.length>=1&&n.length<=24&&!/[\u0000-\u001f]/.test(n);}
async function sbOpenCreate(nick){
  await sbFetch('/rest/v1/open_accounts',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({nickname:nick})});
  sbSave(null);openSave({nickname:nick});
}
async function sbOpenLogin(nick){
  const rows=await sbFetch('/rest/v1/open_accounts?select=nickname&nick_lc=eq.'+encodeURIComponent(nick.toLowerCase())+'&limit=1');
  if(!rows||!rows.length)throw new Error('Открытого аккаунта с таким ником нет — создай его через «Создать аккаунт»');
  sbSave(null);openSave({nickname:rows[0].nickname});
}
// --- сброс пароля: письмо со ссылкой → возврат на сайт с токеном в #hash → новый пароль ---
async function sbRecover(email){
  const back=authBack();
  await sbFetch('/auth/v1/recover'+back,{method:'POST',body:JSON.stringify({email})});
}
async function sbSetPassword(token,password){
  return await sbFetch('/auth/v1/user',{method:'PUT',body:JSON.stringify({password})},token);
}
async function sbSignOut(){
  try{const t=await sbToken();if(t)await sbFetch('/auth/v1/logout',{method:'POST'},t);}catch(e){}
  sbSave(null);openSave(null);
}
async function sbSubmit(res){
  const body={moves:res.moves,teams:res.teams,shape:res.shape};
  if(sbSession){
    const t=await sbToken();if(!t)throw new Error('Нужно войти в аккаунт');
    body.nickname=sbNick().slice(0,24)||'игрок';
    await sbFetch('/rest/v1/games',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(body)},t);
  }else if(openAcc){
    body.nickname=openAcc.nickname;body.open_account=true;
    await sbFetch('/rest/v1/games',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(body)});
  }else throw new Error('Нужно войти в аккаунт');
}
async function sbBoard(order){
  const rows=await sbFetch('/rest/v1/games?select=user_id,nickname,moves,created_at,open_account&order=moves.'+order+',created_at.asc&limit=100');
  const seen=new Set(),out=[];
  (rows||[]).forEach(r=>{
    const key=r.open_account?'o:'+String(r.nickname).toLowerCase():'u:'+r.user_id;
    if(seen.has(key))return;seen.add(key);if(out.length<15)out.push(r);   // один лучший результат на игрока
  });
  return out;
}
async function sbStats(){
  try{acctStats=await sbFetch('/rest/v1/rpc/account_stats',{method:'POST',body:'{}'});}catch(e){acctStats=null;}
  return acctStats;
}
async function sendResult(res){
  try{
    await sbSubmit(res);resultSent=true;pendingResult=null;
    return '✅ Результат ('+res.moves+' ход.) записан в таблицу лидеров';
  }catch(e){return '⚠ Не удалось записать результат: '+e.message;}
}
// Вызывается, когда игра сообщила о победе (событие game:win).  d = {moves, teams, shape} — данные ИЗ ИГРЫ
async function finishResult(d){
  if(resultSent||!sbOk())return;
  const res={moves:d.moves,teams:d.teams||2,shape:d.shape||'p'};
  let note;
  if(isLogged()){resultSent=true;note=await sendResult(res);}
  else{pendingResult=res;note='Победа за '+res.moves+' ход.! Войди в аккаунт (👤 слева вверху), чтобы записать результат';}
  // ◄── СВЯЗЬ С ИГРОЙ (index.html): текст про результат показывает САМА ИГРА на экране победы через GameAPI
  if(window.GameAPI)GameAPI.showResultNote(note);
}

// ---- интерфейс ----
function el(tag,css,txt,props){const e=document.createElement(tag);if(css)e.style.cssText=css;if(txt!=null)e.textContent=txt;if(props)Object.assign(e,props);return e;}
let acctOverlay=null,acctTab='acct',acctMode='in',acctOpenMode=false,acctDraft={},recov=null,acctNote='';
const CODE_COMMENTS=[
"craft: discard 2 identical + 1 any this turn → nuclear",
"white turn budget in boss mode: 4 moves, max 2 per piece, 1 attack",
"if player king dies in boss fight — AI takes white army",
"Layered Teto is always shown. Optional src can be used later for alt outfits.",
"Keep fallback hidden while layers load.",
"one eye shifts more, opposite eye shifts less opposite direction",
"white, black, neutral are all allies vs boss",
"Boss / radio mega-pawn: players don't control boss",
"empty forward — but boss footprint counts as attack square",
"allies block but not capturable",
"Boss fight: approach from diagonal — 8-dir step + «вверх затем вправо» за один ход",
"combined two orthogonal steps (e.g. up then right) as one move",
"same axis twice → handled as 2 budget moves",
"intermediate must be empty or boss footprint",
"colored attackers + neutrals threaten everyone",
"no checks between sides in boss fight",
"boss fight: no inter-side checks/mates — all legal raw moves vs boss only",
"With nuclear — only fire nuclear, no normal play",
"if nuclear in hand but ritual not started, start or wait",
"shouldn't craft as AI often — if somehow has card, force fire aim after short delay",
"after card effect, make a normal move",
"King always flees as far as possible.",
"maximize distance from boss",
"king should not tank the boss",
"prefer safer distance (~4–6), never stand adjacent",
"attack only if already in range ≤2 and this move hits",
"don't dive in just to poke",
"don't wander closer without a hit",
"base chance ~45% to consider a card",
"find 3x3 with most white material (prefer not empty)",
"protect valuable black piece under threat or king",
"angel on advanced or valuable piece without angel",
"hide a hanging valuable piece",
"spawn near center or near white king",
"during nuke fire phase, only nuclear is usable",
"Chaos card face flash 0.1–1s",
"randomize interval feel: occasionally skip frames via opacity tick",
"skip → up to ~1s perceived",
"Put hand card into reserve only on your turn",
"ready: can select anytime (even opponent turn)",
"never draw glyph on boss footprint — sprite covers 3×3",
"empty cell visual under sprite",
"boss sprites stretched over exact 3×3 cells",
"positions relative to boardEl",
"pawns outside step 2 in any direction → fewer half-moves",
"move toward the nearest edge of the board (into play)",
"clamp to nearest in-bounds",
"capture enemy / be blocked by ally",
"never resize during boss fight",
"angel disabled while standing in demon aura",
"1 second pause after card vanishes, before effect",
"standard order on back rank",
"Keep merge extras + buffs from the actual piece taken from the pool",
"if original base type differed (e.g. merged queen placed on rook home), keep that movement too",
"also transfer buffs from the sacrificed extra piece itself",
"reset castling rights lightly",
"also by reference miss: clear first matching type if still present",
"already removed from hand?",
"don't consume until confirmed in picker",
"random effect among: bang, demon, airstrike, spawn, shield",
"empty: spawn neutral demon knight",
"try place nearby or offboard",
"3 width × 4 height, centered on impact",
"Teto splash covers nuclear owner's cards",
"AI protects 3 valuable pieces",
"auto-continue if user slow",
"main slots of the side WITHOUT nuclear slide off-screen",
"clear their hand → will refill with futures",
"defender is the side WITHOUT nuclear",
"aim near white king or center",
"consume nuclear from AI hand",
"protected → future for 2 pairs of turns (4 half-moves) — guaranteed survival",
"8s silence, then rocket",
"rebirth as red at same cells",
"prefer axis toward epicenter, one cell",
"if target occupied by another red, still try alternate",
"clear remaining reds into boss",
"clear all leftover red walkers everywhere",
"up to 2 red pawns near boss, normal size, oneshot, move like boss",
"oneshot minions of boss shouldn't be on footprint anyway",
"move all minions one step same direction as boss (if free)",
"move from far side first to avoid collisions",
"oneshot capture anything they step on",
"strip any remaining white kings just in case",
"expand board to 13×13, keep pieces centered",
"footprint always counts in boss mode even if glyph missing",
"resync mega origin to actual piece",
"if piece not at top-left of footprint, move reference",
"Phase 2 at 5 HP: becomes officer (bishop), 5 diagonal moves",
"distance to nearest cell of footprint",
"Boss fight: loss if not a single white piece is left (on board or waiting in the future)",
"crush anyone already standing inside",
"refill minions up to 2",
"aggro: nearest non-boss, non-red piece",
"clear NEW footprint completely (no skip — was letting kings live inside)",
"spend remaining white budget attacking boss / repositioning",
"doMove may afterMove or leave budget",
"With nuclear in hand — only nuclear actions allowed",
"auto-select nuclear if present",
"hand only on your turn",
"hard-clear so king cannot be saved again by the same card",
"boss-mode budgets for white: 4 moves total, max 2 per unique piece, 1 attack",
"oneshot red minions: any hit kills them",
"boss hit: damage instead of capturing block",
"if somehow standing on footprint after — digest next",
"mega slide (non-boss controlled rare)",
"Shield on target: bounce attacker back, drop shield (other states stay)",
"Angel glow protection for defender's side: 78% reflect like shield",
"attacker stays on kill square for visual",
"promote after friendly merge too (pawn-base merges)",
"Returning into boss footprint → boss eats the piece (never overwrite boss)",
"ally merge: stack movement + buffs",
"in boss fight kings dying doesn't end the game (white army → AI)",
"black king death also doesn't end boss fight",
"King away (future/frozen) or pieces blocked — do NOT softlock: skip turn",
"caller / skip handles pass",
"true stalemate/mate with king on board",
"Always allow skip on your turn (except game over)",
"only store player-turn checkpoints",
"also highlight remaining kings",
"re-render with kill highlights",
"approach medium range / boss",
"Boss mode: white → black → neutral → boss → white",
"recover missing boss before continuing cycle",
"after neutral move, boss acts",
"force-unlock stuck animation flags so skip always works on your turn",
"mobile: prefer pointerup so tap isn't swallowed",
"failsafe: unstick UI locks and refresh skip button",
"стартовые карты — полностью случайные (по 3 на сторону)",
"AI: 70% future already in reserve (auto king-save)",
"player can receive future in normal rotation",
"Мёбиус ∞: лента 16×4 (8 секторов на кольцо × 4 дорожки) — сплошная восьмёрка",
"стандартная шахматная доска 8×8",
"ширина поля (для Мёбиуса 7, иначе 8)",
"для 7 клеток: R N B Q K B N  (без второй ладьи) или R N B K B N R",
"гарантируем короля в центре-ish",
"Универсальный шаг: на Мёбиусе учитывает переворот через шов",
"пешка: вперёд (с возможным двойным) и взятие по диагонали",
"рокировка: король и ладья на стартовых местах, между ними пусто (≥2 клетки)",
"идущие: фигуры за краем поля по клетке за ход идут к ближайшей клетке поля",
"Мёбиус ∞: слегка меняем число секторов / дорожек",
"сначала самые «свежие» погибшие",
"нейтральные фигуры ходят раз в круг: бьют самое ценное, что достанут",
"кто из врагов может взять клетку (x,y) следующим ходом",
"ИИ: выход из-под шаха, не подставляет фигуры, уводит атакованные, берёт ценное",
"оставить короля под ударом нельзя",
"увести фигуру из-под боя",
"ИИ тянется к пистолету",
"полёт карты из слота на поле, затем эффект",
"цель пересчитывается каждый кадр: карта «прикреплена» к клетке и едет вместе с полем, а не с экраном",
"полёт фигуры между клетками",
"карты босса разыгрываются в его ход, потом выдаются новые",
"id пира (меняется при каждом подключении)",
"постоянный id игрока в комнате (переживает переподключение)",
"заменяем старое подключение этого игрока",
"игрок уже подключился заново",
"возвращение хоста после перезагрузки страницы: комната и партия восстанавливаются из сохранённого состояния",
"старая регистрация на брокере может держаться до минуты",
"страница была перезагружена — поднимаем партию заново",
"потеря связи у гостя: сами пытаемся вернуться по тому же коду",
"если партия идёт — баннер уберёт сообщение «resume»",
"Полный снимок Plus-партии для синхронизации",
"подряд идущие снимки — берём последний",
"ядерка у остальных: те же подсветка зоны, отсчёт и ракета (сами изменения придут снимками)",
"ИИ за пустые места считает только хост, чтобы у всех было одно и то же",
"wait for players then start",
"host still picks board, then lobby",
"клетка занята своей — ждём ещё круг",
"ИИ только если за эту сторону никто не сидит онлайн",
"запись «Вид:команда» — файл показывается как есть, без окраски (для особых фигур конкретной команды)",
"умножение на цвет команды: белое → цвет команды, чёрная обводка остаётся чёрной",
"строго в пределах видимой области viewport",
"толщина всей ленты (шире клетки)",
"hit-area layer (transparent divs for clicks)",
"half columns → left circle, half → right",
"highlight classes via data",
"center of sector for piece + hit",
"selection / moves overlay",
"тап по клетке: считаем по координатам (pointer capture камеры гасит обычный click)",
"кнопки: старые обработчики заменяем, старые «обновлялки» отключаем",
"шанс появления Шута за круг (когда он не на поле)",
"пауза после ухода Шута, кругов",
"сколько кругов короли стоят за границей",
"шанс падения пистолета за круг",
"максимум пистолетов в игре (на полу + в руках)",
"дальность выстрела (клеток, по кругу вокруг фигуры)",
"минимум особых фигур у каждой шахматной стороны",
"шанс, что ладья/конь/слон в начале игры окажется особой фигурой",
"шанс, что конь при первом ходе окажется пони",
"на сколько клеток падает Высокая Тура",
"раз в 2 круга: исчезнуть / встать (иначе продолжает лежать)",
"пистолет на полу (с анимацией падения с неба)",
"выстрел: фигура не двигается, цель падает (лежит)",
"подбираем пистолет, если фигура стоит на его клетке",
"достаёт тростью через клетку — король может быть обложен своими фигурами",
"перепрыгиваем через фигуры, если рядом всё занято",
"Шут забирает обоих королей за границу поля",
"какой стандартной фигурой считаются при «Сбросе»",
"пони: обычный конь, уменьшенный в 2.5 раза",
"Высокая Тура: нижний пиксель текстуры — к нижнему краю клетки, остальное торчит вверх",
"Хтонь: пугает всех, кого «атакует» (линии ферзя и ходы коня, первая фигура на линии)",
"три хода подряд за один ход",
"Цыганский конь: переманивает фигуру на свою сторону",
"Высокая Тура: падает и превращается в стену",
"страховка, если расстановка шла другим путём"
];
function acctBuild(){
  const st=document.createElement('style');
  st.textContent='#acct-bar{position:fixed;top:6px;left:6px;z-index:10000;display:flex;gap:6px}'
   +'#acct-bar button{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(30,30,38,.9);color:#fff;font-size:17px;cursor:pointer;padding:0}'
   +'#acct-ov{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}'
   +'#acct-ov.show{display:flex}'
   +'#acct-box{width:min(92vw,400px);max-height:88vh;overflow:auto;background:#1d1d25;color:#eee;border-radius:14px;padding:14px;box-shadow:0 10px 40px rgba(0,0,0,.6);font:14px/1.35 system-ui,sans-serif}'
   +'#acct-box input[type=text],#acct-box input[type=email],#acct-box input[type=password]{width:100%;box-sizing:border-box;margin:4px 0;padding:9px 10px;border-radius:8px;border:1px solid #444;background:#12121a;color:#fff;font-size:15px}'
   +'#acct-box .ab{padding:9px 12px;border-radius:9px;border:0;background:#2ea6ff;color:#fff;font-size:14px;cursor:pointer}'
   +'#acct-box .ab.sec{background:#33333f}'
   +'#acct-box table{width:100%;border-collapse:collapse;font-size:13px}#acct-box td{padding:3px 4px;border-bottom:1px solid #2c2c38}';
  document.head.appendChild(st);
  const bar=el('div');bar.id='acct-bar';
  const b1=el('button',null,'👤',{title:'Аккаунт'}),b2=el('button',null,'🏆',{title:'Таблицы лидеров'});
  b1.onclick=()=>acctOpen('acct');b2.onclick=()=>acctOpen('top');
  bar.appendChild(b1);bar.appendChild(b2);document.body.appendChild(bar);
  acctOverlay=el('div');acctOverlay.id='acct-ov';
  acctOverlay.addEventListener('pointerdown',e=>{if(e.target===acctOverlay)acctClose();});
  document.body.appendChild(acctOverlay);
}
function acctClose(){acctOverlay.classList.remove('show');}
function acctOpen(tab){acctTab=tab;acctOverlay.classList.add('show');acctRender();}
function acctRender(){
  acctOverlay.textContent='';
  const box=el('div');box.id='acct-box';acctOverlay.appendChild(box);
  const tabs=el('div','display:flex;gap:6px;margin-bottom:10px');
  [['acct','👤 Аккаунт'],['top','🏆 Лидеры']].forEach(([k,t])=>{
    const b=el('button',null,t,{className:'ab'+(acctTab===k?'':' sec'),style:'flex:1'});
    b.onclick=()=>{acctTab=k;acctRender();};tabs.appendChild(b);
  });
  const x=el('button','background:none;border:0;color:#aaa;font-size:20px;cursor:pointer','✕');x.onclick=acctClose;tabs.appendChild(x);
  box.appendChild(tabs);
  if(!sbOk()){box.appendChild(el('div','color:#ffb020','Не задан ключ Supabase: впиши SB_KEY в index.html.'));}
  if(acctTab==='top')acctBoards(box);else acctForm(box);
}
// заголовок + число существующих аккаунтов справа
function acctHeader(box,title){
  const row=el('div','display:flex;justify-content:space-between;align-items:center;margin-bottom:6px');
  row.appendChild(el('div','font-size:16px',title));
  const badge=el('span','font-size:12px;color:#9ad;background:#12121a;border-radius:10px;padding:3px 9px;white-space:nowrap');
  const show=()=>{
    if(!acctStats){badge.textContent='👥 …';return;}
    const r=+acctStats.registered||0,o=+acctStats.open||0;
    badge.textContent='👥 '+(r+o);badge.title='Обычных: '+r+', открытых: '+o;
  };
  show();row.appendChild(badge);box.appendChild(row);
  if(sbOk())sbStats().then(()=>{if(badge.isConnected)show();});
}
// вместо адреса проекта — случайный комментарий из кода игры (клик — другой)
function acctUrlBtn(box){
  const pick=()=>'// '+CODE_COMMENTS[Math.floor(Math.random()*CODE_COMMENTS.length)];
  const d=el('div','margin-top:12px;color:#6f7d8c;font:11px/1.4 ui-monospace,Consolas,monospace;word-break:break-word;cursor:pointer;user-select:none',pick(),{title:'Нажми — другой комментарий'});
  d.onclick=()=>{d.textContent=pick();};
  box.appendChild(d);
}
const AUTH_SITE='https://chessrandomiauth.devs.li/',ERR_SITE='http://chessrandomierr.duckdns.org/';   // ERR — http, не https
let acctInfo='';
function errGo(reason){location.href=ERR_SITE+'?from=game&reason='+reason+'&back='+encodeURIComponent(location.origin+location.pathname);}
// переход на сайт входа; если он лежит или на нём тех. работы (status.json) — уходим на резервный
async function goAuth(mode){
  const sig=()=>{const c=new AbortController();setTimeout(()=>c.abort(),6000);return c.signal;};
  let ok=false,maint=false;
  try{const r=await fetch(AUTH_SITE+'status.json?'+Date.now(),{cache:'no-store',signal:sig()});if(r.ok){const j=await r.json().catch(()=>({}));maint=!!j.maintenance;}ok=true;}
  catch(e){try{await fetch(AUTH_SITE,{mode:'no-cors',cache:'no-store',signal:sig()});ok=true;}catch(e2){}}
  if(!ok)return errGo('auth_unreachable');
  if(maint)return errGo('maintenance');
  const st=Math.random().toString(36).slice(2);
  try{sessionStorage.setItem('ca_state',st);if(pendingResult)localStorage.setItem('ca_pending',JSON.stringify(pendingResult));}catch(e){}
  location.href=AUTH_SITE+'?return='+encodeURIComponent(location.origin+location.pathname)+'&state='+st+(mode?'&mode='+mode:'');
}
function acctForm(box){
  const msg=el('div','margin-top:8px;min-height:18px;color:#7be07b');
  if(acctInfo){msg.textContent=acctInfo;acctInfo='';}
  if(isLogged()){
    acctHeader(box,'Аккаунт');
    box.appendChild(el('div','font-size:17px;margin-bottom:4px','Привет, '+sbNick()+'!'));
    box.appendChild(el('div','color:#aaa;margin-bottom:8px',sbSession?((sbSession.user&&sbSession.user.email)||'Вход через соцсеть'):'🔓 Открытый аккаунт (без пароля)'));
    box.appendChild(el('div','margin-bottom:10px','Ходов в текущей партии: '+curMoves));
    if(pendingResult){
      const pb=el('button',null,'Записать результат ('+pendingResult.moves+' ход.)',{className:'ab'});
      pb.onclick=async()=>{acctInfo=await sendResult(pendingResult);acctRender();};box.appendChild(pb);
    }
    const lo=el('button','margin-left:6px','Выйти',{className:'ab sec'});
    lo.onclick=async()=>{await sbSignOut();acctRender();};box.appendChild(lo);
    const sw=el('button','margin-left:6px','Сменить',{className:'ab sec'});sw.onclick=()=>goAuth('');box.appendChild(sw);
  }else{
    acctHeader(box,'Вход');
    box.appendChild(el('div','color:#aaa;margin-bottom:6px','Вход и регистрация — на отдельном сайте: почта, Discord, GitHub, Google и другие способы. Результаты попадут в таблицу лидеров.'));
    [['🔑 Войти',''],['✨ Регистрация','signup'],['🔓 Открытый аккаунт (только ник)','open']].forEach(([t,m],i)=>{
      const b=el('button','display:block;width:100%;margin-top:6px',t,{className:'ab'+(i?' sec':'')});
      b.onclick=async()=>{b.disabled=true;b.textContent='Открываю…';await goAuth(m);b.disabled=false;b.textContent=t;};box.appendChild(b);
    });
    if(pendingResult)box.appendChild(el('div','margin-top:8px;color:#ffcf70;font-size:12px','Результат ('+pendingResult.moves+' ход.) запишется после входа'));
  }
  box.appendChild(msg);acctUrlBtn(box);
}
function acctBoards(box){
  acctHeader(box,'Лидеры');
  const mk=(title,order,hint)=>{
    box.appendChild(el('div','font-size:15px;margin:10px 0 2px',title));
    box.appendChild(el('div','color:#999;font-size:12px;margin-bottom:4px',hint));
    const holder=el('div',null,'Загрузка…');box.appendChild(holder);
    if(!sbOk()){holder.textContent='—';return;}
    sbBoard(order).then(rows=>{
      holder.textContent='';
      if(!rows.length){holder.textContent='Пока пусто';return;}
      const tb=el('table');
      rows.forEach((r,i)=>{
        const tr=el('tr');
        [i+1,(r.open_account?'🔓 ':'')+r.nickname,r.moves+' ход.',(r.created_at||'').slice(0,10)].forEach((v,j)=>tr.appendChild(el('td',j===2?'text-align:right;font-weight:600':(j===3?'color:#888;text-align:right':''),String(v))));
        const mine=(sbSession&&sbSession.user&&!r.open_account&&r.user_id===sbSession.user.id)||(openAcc&&r.open_account&&String(r.nickname).toLowerCase()===openAcc.nickname.toLowerCase());
        if(mine)tr.style.background='rgba(46,166,255,.15)';
        tb.appendChild(tr);
      });
      holder.appendChild(tb);
    }).catch(e=>{holder.style.color='#ff7070';holder.textContent=e.message;});
  };
  mk('🐢 Самая долгая победа','desc','Больше всего ходов в выигранной партии');
  mk('⚡ Самая быстрая победа','asc','Меньше всего ходов в выигранной партии');
}
acctBuild();

// Возврат с сайта входа: данные приходят в #ca=<base64url JSON> (токен в адресной строке сразу убираем)
(function(){
  const m=location.hash.match(/[#&]ca=([^&]+)/);if(!m)return;
  try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
  let p;try{p=JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g,'+').replace(/_/g,'/')))));}catch(e){return;}
  let st=null;try{st=sessionStorage.getItem('ca_state');sessionStorage.removeItem('ca_state');}catch(e){}
  (async()=>{
    if(!(p.state&&p.state===st)&&!confirm('Войти в игру как «'+(p.nick||p.nickname||'игрок')+'»?'))return;   // защита от чужой ссылки
    try{
      if(p.t==='open')await sbOpenLogin(p.nickname);
      else{const u=await sbFetch('/auth/v1/user',{},p.access_token);   // пользователя берём у сервера, а не из ссылки
        sbSave({access_token:p.access_token,refresh_token:p.refresh_token,expires_at:p.expires_at,user:u});openSave(null);}
      let pr=null;try{pr=JSON.parse(localStorage.getItem('ca_pending')||'null');localStorage.removeItem('ca_pending');}catch(e){}
      acctInfo=pr?await sendResult(pr):'✅ Вы вошли';
    }catch(e){acctInfo='⚠ '+e.message;}
    acctOpen('acct');
  })();
})();

/* ══════════════════════════════════════════════════════════════════════════
   ◄── СВЯЗЬ С ИГРОЙ (index.html): подписка на события игры
   Игра ничего не знает про аккаунты: она только вызывает GameEvents.emit(...).
   Эти три строки — ЕДИНСТВЕННОЕ место, где accounts.js реагирует на игру.
   Откуда эмитятся события — см. в index.html блок «СВЯЗЬ С accounts.js».
   ══════════════════════════════════════════════════════════════════════════ */
if(window.GameEvents){
  // новая партия → обнуляем «текущую партию»
  GameEvents.on('game:start',()=>{curMoves=0;pendingResult=null;resultSent=false;});
  // белые (игрок) сделали ход → запоминаем число ходов (показывается в окне аккаунта)
  GameEvents.on('game:move',d=>{curMoves=d.moves;});
  // партия выиграна → записываем результат в Supabase (или ждём входа в аккаунт)
  GameEvents.on('game:win',d=>{finishResult(d);});
}else{
  console.warn('accounts.js: GameEvents не найден — подключай accounts.js ПОСЛЕ моста в index.html');
}

// Небольшой публичный API (на случай, если игре понадобится открыть окно аккаунта из своего кода)
window.Accounts={open:acctOpen,isLogged:()=>isLogged(),nickname:()=>sbNick()};

})();
