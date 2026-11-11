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
  catch(e){throw new Error('Нет связи с Supabase ('+sbUrl().replace(/^https?:\/\//,'')+'). Проверь адрес проекта (кнопка «Адрес проекта» ниже) и интернет.');}
  let j=null;try{j=await r.json();}catch(e){}
  if(!r.ok){
    let m=(j&&(j.msg||j.message||j.error_description||j.error))||('Ошибка '+r.status);
    const L=[
      [/invalid login credentials/i,'Неверный email или пароль (или email ещё не подтверждён)'],
      [/email not confirmed/i,'Email не подтверждён: открой ссылку из письма (проверь «Спам»)'],
      [/rate limit|too many/i,'Слишком много попыток или писем. Подожди или отключи подтверждение email в Supabase'],
      [/already registered|already been registered/i,'Этот email уже зарегистрирован — нажми «У меня есть аккаунт» и войди'],
      [/password should be at least/i,'Пароль слишком короткий (минимум 6 символов)'],
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
function sbNick(){
  if(sbSession){const u=sbSession.user;return (u&&u.user_metadata&&u.user_metadata.nickname)||((u&&u.email)||'').split('@')[0];}
  return openAcc?openAcc.nickname:'';
}
// --- обычный аккаунт (email + пароль) ---
async function sbSignUp(email,password,nick){
  const back=/^https?:$/.test(location.protocol)?'?redirect_to='+encodeURIComponent(location.origin+location.pathname):'';
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
let acctOverlay=null,acctTab='acct',acctMode='in',acctOpenMode=false,acctDraft={};
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
function acctUrlBtn(box){
  const b=el('button','margin-top:10px;background:none;border:0;color:#7aa7ff;font-size:12px;cursor:pointer;padding:0;text-decoration:underline','Адрес проекта: '+sbUrl().replace(/^https?:\/\//,''));
  b.onclick=()=>{const v=prompt('Project URL из Supabase → Project Settings → API\n(вида https://xxxxxxxxxxxxxxxxxxxx.supabase.co или только 20-символьный id)',sbUrl());if(v!==null){if(/^sb_(publishable|secret)/i.test(v.trim()))alert('Это ключ, а не адрес. Ключ уже вписан в игру. Нужен Project URL вида https://xxxxxxxxxxxxxxxxxxxx.supabase.co');else if(!sbSetUrl(v))alert('Не похоже на адрес проекта. Нужен вид https://xxxxxxxxxxxxxxxxxxxx.supabase.co (или только 20-символьный id)');acctRender();}};
  box.appendChild(b);
}
function acctForm(box){
  const msg=el('div','margin-top:8px;min-height:18px;color:#ffb020');
  if(isLogged()){
    acctHeader(box,'Аккаунт');
    box.appendChild(el('div','font-size:17px;margin-bottom:4px','Привет, '+sbNick()+'!'));
    box.appendChild(el('div','color:#aaa;margin-bottom:8px',sbSession?((sbSession.user&&sbSession.user.email)||''):'🔓 Открытый аккаунт (без пароля)'));
    box.appendChild(el('div','margin-bottom:10px','Ходов в текущей партии: '+curMoves));
    if(pendingResult){
      const pb=el('button',null,'Записать результат ('+pendingResult.moves+' ход.)',{className:'ab'});
      pb.onclick=async()=>{msg.textContent='Отправляю…';msg.textContent=await sendResult(pendingResult);acctRender();};
      box.appendChild(pb);
    }
    const lo=el('button','margin-left:6px','Выйти',{className:'ab sec'});
    lo.onclick=async()=>{await sbSignOut();acctRender();};box.appendChild(lo);box.appendChild(msg);acctUrlBtn(box);return;
  }
  const up=acctMode==='up',open=acctOpenMode;
  acctHeader(box,up?'Регистрация':'Вход');
  const d=acctDraft;
  const em=el('input',null,null,{type:'email',placeholder:'Email (для входа — не ник)',autocomplete:'email',value:d.email||''});
  const pw=el('input',null,null,{type:'password',placeholder:'Пароль (от 6 символов)',autocomplete:up?'new-password':'current-password',value:d.pass||''});
  const nk=el('input',null,null,{type:'text',placeholder:open?'Ник':'Ник (для таблицы лидеров)',maxLength:24,value:d.nick||''});
  if(!open)box.appendChild(em);
  if(up||open)box.appendChild(nk);
  if(!open)box.appendChild(pw);
  const lab=el('label','display:flex;gap:8px;align-items:center;margin:8px 0 2px;font-size:13px;color:#cde;cursor:pointer');
  const cb=el('input',null,null,{type:'checkbox',checked:open});cb.style.cssText='width:auto;margin:0';
  cb.onchange=()=>{acctDraft={email:em.value,pass:pw.value,nick:nk.value};acctOpenMode=cb.checked;acctRender();};
  lab.appendChild(cb);lab.appendChild(el('span',null,up?'Открытый аккаунт: без пароля и почты':'Войти в открытый аккаунт (только ник)'));
  box.appendChild(lab);
  const go=el('button','margin-top:6px',up?'Зарегистрироваться':'Войти',{className:'ab'});
  const sw=el('button','margin-top:6px;margin-left:6px',up?'У меня есть аккаунт':'Создать аккаунт',{className:'ab sec'});
  sw.onclick=()=>{acctDraft={email:em.value,pass:pw.value,nick:nk.value};acctMode=up?'in':'up';acctRender();};
  const run=async()=>{
    const email=em.value.trim(),pass=pw.value,nick=nk.value.trim();
    msg.style.color='#ffb020';
    if(!sbOk()){msg.textContent='Не задан ключ Supabase';return;}
    if(open){
      if(!nickOk(nick)){msg.textContent='Введи ник (1–24 символа)';return;}
    }else{
      if(!email||!pass){msg.textContent='Введи email и пароль';return;}
      if(!/^\S+@\S+\.\S+$/.test(email)){msg.style.color='#ff7070';msg.textContent='Для входа нужен email (тот, что указан при регистрации), а не ник';return;}
      if(up&&!nickOk(nick)){msg.textContent='Введи ник (1–24 символа)';return;}
    }
    go.disabled=true;msg.textContent='Подождите…';
    try{
      if(open){if(up)await sbOpenCreate(nick);else await sbOpenLogin(nick);}
      else if(up){
        const r=await sbSignUp(email,pass,nick);
        if(r==='confirm'){msg.style.color='#7be07b';msg.textContent='Готово! Если подтверждение включено — открой ссылку из письма (проверь «Спам»), затем войди.';acctMode='in';go.disabled=false;return;}
      }else await sbSignIn(email,pass);
      acctDraft={};
      if(pendingResult&&!resultSent){await sendResult(pendingResult);}
      acctRender();
    }catch(e){msg.style.color='#ff7070';msg.textContent=e.message;go.disabled=false;}
  };
  go.onclick=run;[em,pw,nk].forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')run();}));
  box.appendChild(go);box.appendChild(sw);box.appendChild(msg);
  if(up&&open)box.appendChild(el('div','margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(255,176,32,.12);color:#ffcf70;font-size:12px','⚠ Открытый аккаунт создаётся без пароля и почты: в него сможет войти кто угодно, зная ник, и записывать результаты от твоего имени. Не используй его для чего-то важного.'));
  acctUrlBtn(box);
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
