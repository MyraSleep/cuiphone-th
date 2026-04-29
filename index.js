/* sxiphone-style CuiPhone for TavernHelper
 * Built 2026-04-29T12:51:04.986Z
 * Source: https://github.com/zhijunzhongzzj-jpg/Extension-CuiPhone
 *
 * Usage in TavernHelper:
 *   import 'https://<your-pages-host>/index.js'
 */
(function bootstrap() {
    const _iframeWin = (typeof globalThis !== 'undefined') ? globalThis : self;
    let _parentWin = _iframeWin;
    try {
        if (_iframeWin.parent && _iframeWin.parent !== _iframeWin && _iframeWin.parent.document) {
            _parentWin = _iframeWin.parent;
        }
    } catch (e) { /* cross-origin or no parent — fall back to self */ }
    // Re-export TH globals from the iframe window onto parent so window.TavernHelper
    // still works when the inner code uses our shadowed 'window'.
    if (_parentWin !== _iframeWin) {
        for (const k of ['TavernHelper', 'eventOn', 'tavern_events', 'getChatMessages',
                         'getVariables', 'replaceVariables', 'toastr', 'SillyTavern']) {
            try {
                if (_iframeWin[k] !== undefined && _parentWin[k] === undefined) {
                    _parentWin[k] = _iframeWin[k];
                }
            } catch (e) { /* readonly — ignore */ }
        }
    }
    // === DIAGNOSTIC BEACON ===
    // Drop a small visible marker so users (especially on mobile, where DevTools
    // are awkward) can SEE whether the script actually started and whether we
    // could reach the parent DOM. Tap it to dismiss.
    try {
        const _doc = _parentWin.document || _iframeWin.document;
        const _crossOrigin = (_parentWin === _iframeWin);
        const beacon = _doc.createElement('div');
        beacon.id = 'cui-phone-beacon';
        beacon.textContent = _crossOrigin
            ? 'CuiPhone: 父页面跨源不可达，已挂在 iframe（不可见）。点我隐藏'
            : 'CuiPhone 已加载✓ 点我隐藏';
        beacon.style.cssText = [
            'position:fixed', 'left:8px', 'top:8px',
            'z-index:2147483647',
            'background:' + (_crossOrigin ? '#dc2626' : '#10b981'),
            'color:#fff', 'font:600 12px/1.2 system-ui,-apple-system,sans-serif',
            'padding:8px 12px', 'border-radius:8px',
            'box-shadow:0 4px 16px rgba(0,0,0,.3)',
            'cursor:pointer', '-webkit-tap-highlight-color:transparent',
            'max-width:90vw'
        ].join(';');
        beacon.addEventListener('click', () => beacon.remove(), { once: true });
        // Auto-dismiss after 8s so it doesn't linger forever.
        setTimeout(() => { try { beacon.remove(); } catch (e) {} }, 8000);
        (_doc.body || _doc.documentElement).appendChild(beacon);
    } catch (e) {
        // Try to surface the error somewhere visible
        try {
            const t = _iframeWin.toastr || (_parentWin && _parentWin.toastr);
            t && t.error && t.error('CuiPhone beacon failed: ' + (e && e.message));
        } catch (e2) {}
    }

    // Run the entire phone bundle with shadowed document/window pointing at parent.
    (function CuiPhoneInner(window, document, navigator, location) {
        'use strict';

// ===== st-bridge.js (TH-adapted) =====
/* =====================================================================
 * CUI Phone — SillyTavern <-> Phone bridge
 * ---------------------------------------------------------------------
 * Listens to ST chat events. On every change it scans ALL chat messages
 * for <kakao_chat> / <ins_feed> / <ins_story> / <user_profile> blocks,
 * concatenates the matches, and pushes them into the phone UI via
 * CuiPhone.applyImport().
 *
 * Rationale: the worldbook instructs the LLM to wrap KKT and INS output
 * in those tags. The phone is a renderer for those tags — not a literal
 * mirror of the chat log.
 * ===================================================================== */

const BLOCK_PATTERNS = [
    /<kakao_chat>[\s\S]*?<\/kakao_chat>/g,
    /<ins_feed>[\s\S]*?<\/ins_feed>/g,
    /<ins_story>[\s\S]*?<\/ins_story>/g,
    /<user_profile>[\s\S]*?<\/user_profile>/g,
];

/** Resolve a usable avatar URL from a character object. */
function resolveAvatarUrl(character) {
    if (!character) return '';
    const file = character.avatar;
    if (!file || file === 'none') return '';
    return `/thumbnail?type=avatar&file=${encodeURIComponent(file)}`;
}

/** Pull all matching wrapped blocks out of the chat log, in order. */
function extractBlocksFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) return '';
    const pieces = [];
    for (const m of chat) {
        const text = typeof m?.mes === 'string' ? m.mes : '';
        if (!text) continue;
        for (const re of BLOCK_PATTERNS) {
            const found = text.match(re);
            if (found) pieces.push(...found);
        }
    }
    return pieces.join('\n\n');
}

/**
 * Auto-detect the most recent room/chat to focus.
 * If the latest LLM message contains a <kakao_chat>, jump to that room.
 */
function pickActivePanel(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const t = chat[i]?.mes || '';
        if (/<kakao_chat>/.test(t)) return 'kkt';
        if (/<ins_story>/.test(t)) return 'story';
        if (/<ins_feed>/.test(t)) return 'feed';
    }
    return null;
}

function wireSTBridge(ctx, phone) {
    if (!phone) {
        console.warn('[CUI Phone] window.CuiPhone is not ready; bridge skipped.');
        return;
    }
    // TH-friendly bridge: prefer TH globals, fall back to ST ctx.
    const TH = (typeof window !== 'undefined') ? window : {};
    const _eventOn = TH.eventOn || null;
    const _thEvents = TH.tavern_events || null;
    const _getChatMessages = TH.getChatMessages || null;
    const eventSource = ctx.eventSource || null;
    const event_types = ctx.event_types || null;

    const getCurrentCharacter = () => {
        const c = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext()
            : (window.TavernHelper || {});
        const idx = c.characterId;
        const ch = (idx != null) ? c.characters?.[idx] : null;
        if (!ch) return null;
        return {
            name: ch.name,
            avatar: resolveAvatarUrl(ch),
            description: ch.description || '',
        };
    };

    const sync = async () => {
        try {
            const c = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext()
            : (window.TavernHelper || {});
            let chat = c.chat || [];
            if ((!chat || !chat.length) && typeof _getChatMessages === 'function') {
                try {
                    const msgs = await _getChatMessages('0-{{lastMessageId}}');
                    if (Array.isArray(msgs)) {
                        chat = msgs.map(m => ({
                            mes: (typeof m?.message === 'string') ? m.message
                               : (typeof m?.mes === 'string') ? m.mes
                               : '',
                            is_user: !!m?.is_user,
                            name: m?.name,
                        }));
                    }
                } catch (err) { /* fall back to whatever c.chat had */ }
            }
            const importText = extractBlocksFromChat(chat);
            const character = getCurrentCharacter();

            if (importText) {
                // Reset rooms list before applying so old <kakao_chat> data
                // from previous chats doesn't linger.
                phone.state.rooms = [];
                phone.state.threads = {};
                phone.applyImport(importText);

                // If the parsed rooms have no avatar, fall back to ST character avatar
                if (character && phone.state.rooms.length) {
                    for (const room of phone.state.rooms) {
                        if (!room.avatar && room.name === character.name) {
                            phone.state.roomIdentity[room.id] = {
                                name: character.name,
                                avatar: character.avatar,
                            };
                        }
                    }
                    phone.renderChatList?.();
                    phone.renderThread?.();
                }

                // Auto-jump to the panel that was just produced
                const target = pickActivePanel(chat);
                if (target === 'kkt') phone.switchKktPanel?.('list');
                if (target === 'feed') phone.switchInsPanel?.('feed');
                if (target === 'story') phone.switchInsPanel?.('story');
            } else {
                // No wrapped blocks anywhere — show empty state
                phone.state.rooms = [];
                phone.state.threads = {};
                phone.state.stories = [];
                phone.state.posts = [];
                phone.renderChatList?.();
                phone.renderThread?.();
            }
        } catch (e) {
            console.error('[CUI Phone] sync failed:', e);
        }
    };

    // Initial sync (in case chat is already populated when extension loads)
    setTimeout(sync, 200);

    const events = [
        'CHAT_CHANGED',
        'MESSAGE_RECEIVED',
        'MESSAGE_SENT',
        'MESSAGE_EDITED',
        'MESSAGE_DELETED',
        'MESSAGE_SWIPED',
        'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED',
    ];
    for (const key of events) {
        // Prefer TH bindings when available
        if (_eventOn && _thEvents && _thEvents[key]) {
            try { _eventOn(_thEvents[key], sync); continue; } catch (e) { /* fall through */ }
        }
        // Fall back to ST's eventSource
        if (eventSource && event_types) {
            const t = event_types[key];
            if (t) {
                try { eventSource.on(t, sync); } catch (e) { /* ignore */ }
            }
        }
    }

    /**
     * Send a message from the phone UI into ST's main composer.
     * Strategy: write into #send_textarea + click #send_but. Works across
     * recent ST versions; verify against your installed version if needed.
     */
    phone.sendToST = async (text) => {
        if (!text || !text.trim()) return;
        const ta = document.querySelector('#send_textarea');
        const btn = document.querySelector('#send_but');
        if (!ta || !btn) {
            console.warn('[CUI Phone] ST composer not found.');
            return;
        }
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
        btn.click();
    };

    // Manual refresh helper (handy in DevTools)
    phone.forceSync = sync;
    phone._st = { getCurrentCharacter, extractBlocksFromChat, sync };

    console.log('[CUI Phone] ST bridge wired (auto-detects <kakao_chat>/<ins_feed>/<ins_story>).');
}

window.__cuiPhoneWireBridge = wireSTBridge;


// ===== phone.js =====
/* =====================================================================
 * CUI Phone — phone UI (extracted from clean HTML, scoped to mount root)
 * ===================================================================== */

function mountPhoneUI(root) {
    const state = {
      currentView:'lock',
      currentInsPanel:'feed',
      currentKktPanel:'list',
      currentStory:0,
      storyStartX:0,
      currentRoom:'',
      composeMode:'feed',
      callTimer:null,
      callSeconds:0,
      user:{handle:'me',name:'未设置',bio:'在世界书里加 <user_profile> 设置你的账号，或在主页点击“编辑主页”。',link:'',avatar:'',posts:0,followers:0,following:0,highlights:[],grid:[]},
      avatars:{'@me':''},
      stories:[],
      posts:[],
      rooms:[],
      roomIdentity:{},
      threads:{},
      defaultImport:''
    };

    const defaultImportText = '';

    // ---- Persistent storage for user profile (Plan A: global, shared across characters) ----
    // ONLY user.* fields and sticker base are persisted. posts / stories / rooms / threads
    // are intentionally NOT stored here, so per-character INS/Kakao content stays isolated.
    const STORAGE_KEY = 'cuiphone:user_profile_v1';
    const STORAGE_KEY_STICKER = 'cuiphone:sticker_base_v1';
    const DEFAULT_USER = {handle:'me',name:'未设置',bio:'在世界书里加 <user_profile> 设置你的账号，或在主页点击“编辑主页”。',link:'',avatar:'',posts:0,followers:0,following:0,highlights:[],grid:[]};
    function loadPersistedUser(){
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if(!raw) return null;
        const obj = JSON.parse(raw);
        if(obj && typeof obj === 'object') return obj;
      } catch(_){}
      return null;
    }
    function persistUser(){
      try {
        const u = state.user;
        const slim = {handle:u.handle,name:u.name,bio:u.bio,link:u.link,avatar:u.avatar,followers:u.followers,following:u.following,highlights:u.highlights,grid:u.grid};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
      } catch(_){}
    }
    function loadPersistedStickerBase(){
      try { return localStorage.getItem(STORAGE_KEY_STICKER) || ''; } catch(_) { return ''; }
    }
    function persistStickerBase(){
      try { localStorage.setItem(STORAGE_KEY_STICKER, _stickerBase || ''); } catch(_){}
    }
    function clearPersistedUser(){
      try { localStorage.removeItem(STORAGE_KEY); } catch(_){}
    }

    const $ = s => root.querySelector(s);
    const $$ = s => Array.from(root.querySelectorAll(s));
    const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const isImageUrl = v => /^(https?:)?\/\//i.test(String(v || '').trim()) || /^data:image\//i.test(String(v || '').trim());
    const cssUrl = v => String(v || '').replace(/"/g,'\\"').replace(/\n/g,'');
    const likesText = n => `${Number(n || 0).toLocaleString('en-US')} likes`;
    const EMPTY_ROOM = {id:'',name:'',avatar:'',preview:'',time:'',unread:0,kind:'',read:true};
    const roomById = id => state.rooms.find(r => r.id === id) || state.rooms[0] || EMPTY_ROOM;

    function applyAvatar(el, value, fallback){
      if(!el) return;
      const raw = String(value || '').trim();
      const hasImage = isImageUrl(raw);
      el.style.backgroundImage = hasImage ? `url("${cssUrl(raw)}")` : 'none';
      el.classList.toggle('has-image', hasImage);
      el.textContent = hasImage ? '' : String(raw || fallback || '').slice(0,3).toUpperCase();
    }

    function switchView(name){
      state.currentView = name;
      $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    }
    function switchInsPanel(name){
      state.currentInsPanel = name;
      $$('[data-ins-panel]').forEach(p => p.classList.toggle('active', p.dataset.insPanel === name));
      $$('.ins-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.insTab === name));
      const sub = $('#insSubline');
      if(sub) sub.textContent = name === 'feed' ? 'Following feed' : name === 'story' ? 'Story preview' : 'Profile';
    }
    function switchKktPanel(name){
      state.currentKktPanel = name;
      $$('[data-kkt-panel]').forEach(p => p.classList.toggle('active', p.dataset.kktPanel === name));
      const sub = $('#kktSubline');
      if(sub) sub.textContent = name === 'list' ? 'Chats' : '单聊';
    }

    function parseLikes(line){
      const m = String(line || '').match(/([0-9][0-9,]*)/);
      return m ? parseInt(m[1].replace(/,/g,''), 10) : 0;
    }

    function parseStoryBlocks(text){
      const matches = [...String(text || '').matchAll(/<ins_story>\s*([\s\S]*?)\s*<\/ins_story>/g)];
      return matches.map(m => m[1].trim()).filter(Boolean).map(block => {
        const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
        const head = lines.shift() || '';
        // Accept "@handle · name | HH:MM [氛围/地点...]" (optional trailing text).
        const hm = head.match(/^(@\S+)\s*[·•]\s*(.+?)\s*\|\s*(\d{1,2}:\d{2})(?:\s+(.*))?$/);
        const handle = hm ? hm[1] : (head.match(/@\S+/)?.[0] || '');
        const name = hm ? hm[2].trim() : '';
        const time = hm ? hm[3] : '';
        const mood = hm && hm[4] ? hm[4].trim() : '';
        let mediaUrl = '';
        const chips = [];
        lines.forEach(line => {
          if(/^图片[:：]/i.test(line)){ mediaUrl = line.replace(/^图片[:：]\s*/i,'').trim(); return; }
          if(/^\[贴纸/.test(line)){ chips.push({type:'sticker',text:line}); return; }
          if(/^\[音乐/.test(line)){ chips.push({type:'music',text:line.replace(/^\[音乐\s*·?\s*/,'').replace(/\]$/,'')}); return; }
          chips.push({type:'text',text:line.replace(/^story\s*字幕[:：]?\s*/i,'')});
        });
        if(handle && !(handle in state.avatars)) state.avatars[handle] = '';
        return {handle,name,time,mood,avatar:handle ? (state.avatars[handle] || '') : '',mediaUrl,bg:'radial-gradient(circle at 52% 18%, rgba(255,255,255,.18), transparent 22%), linear-gradient(160deg,#0f172a,#334155 52%,#475569)',chips};
      });
    }

    function parseInsProfiles(text){
      const m = String(text || '').match(/<ins_profiles>\s*([\s\S]*?)\s*<\/ins_profiles>/);
      if(!m) return;
      m[1].split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
        const eq = line.indexOf('=');
        if(eq < 0) return;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if(!key.startsWith('@')) return;
        state.avatars[key] = val;
      });
    }

    function parseStickerBase(text){
      const m = String(text || '').match(/<sticker_base>\s*([\s\S]*?)\s*<\/sticker_base>/);
      if(m){ _stickerBase = m[1].trim(); persistStickerBase(); }
    }

    function parseFeedBlocks(text){
      // Only parse content INSIDE <ins_feed>...</ins_feed>. If no such block
      // exists, return [] — never fall back to raw text (which would let
      // <kakao_chat> blocks leak into the feed).
      const matches = [...String(text || '').matchAll(/<ins_feed>\s*([\s\S]*?)\s*<\/ins_feed>/g)];
      if (!matches.length) return [];
      const inner = matches.map(m => m[1].trim()).join('\n\n');
      const groups = inner.split(/\n\s*\n(?=@)/).map(s => s.trim()).filter(Boolean);
      const bgs = [
        'radial-gradient(circle at 50% 18%, rgba(255,255,255,.18), transparent 22%), linear-gradient(160deg,#111827,#243447 52%,#0f172a)',
        'radial-gradient(circle at 30% 18%, rgba(255,255,255,.16), transparent 20%), linear-gradient(160deg,#0f766e,#115e59 55%,#022c22)',
        'radial-gradient(circle at 50% 12%, rgba(255,255,255,.15), transparent 18%), linear-gradient(160deg,#7c2d12,#c2410c 58%,#431407)',
        'radial-gradient(circle at 52% 16%, rgba(255,255,255,.16), transparent 18%), linear-gradient(160deg,#172554,#1d4ed8 55%,#0f172a)'
      ];
      return groups.map((group, idx) => {
        const lines = group.split('\n').map(s => s.trim()).filter(Boolean);
        const head = lines.shift() || '';
        const media = lines.shift() || '';
        let mediaUrl = '';
        if(/^图片[:：]/i.test(lines[0] || '')) mediaUrl = lines.shift().replace(/^图片[:：]\s*/i,'').trim();
        // Like count: explicit ❤️ line wins; otherwise compute a stable
        // pseudo-random number from handle+caption so the same post always
        // shows the same number across refreshes (no jitter).
        let likes = -1; // sentinel: not set
        if(/^❤️/.test(lines[0] || '')) likes = parseLikes(lines.shift());
        const caption = lines.shift() || '';
        const comments = lines;
        const hm = head.match(/^(@\S+)\s*[·•]\s*(.+?)\s*\|\s*(.*)$/);
        const handle = hm ? hm[1] : (head.match(/@\S+/)?.[0] || '');
        const name = hm ? hm[2].trim() : '';
        const place = hm ? hm[3].trim() : '';
        if(handle && !(handle in state.avatars)) state.avatars[handle] = '';
        if(likes < 0){
          // Stable hash → likes between 80 and 4500.
          let h = 0; const seed = handle + '|' + caption + '|' + media;
          for(let i = 0; i < seed.length; i++){ h = ((h << 5) - h + seed.charCodeAt(i)) | 0; }
          likes = 80 + Math.abs(h) % 4421;
        }
        return {handle,name,place,likes,caption,comments,overlay:media,mediaUrl,avatar:handle ? (state.avatars[handle] || '') : '',bg:bgs[idx % bgs.length]};
      });
    }

    function parseUserProfile(text){
      const match = String(text || '').match(/<user_profile>\s*([\s\S]*?)\s*<\/user_profile>/);
      if(!match) return;
      match[1].split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
        const [key, ...rest] = line.split('=');
        const val = rest.join('=').trim();
        if(!key) return;
        const k = key.trim();
        if(k === 'handle') state.user.handle = val.replace(/^@/, '') || state.user.handle;
        if(k === 'name') state.user.name = val || state.user.name;
        if(k === 'bio') state.user.bio = val || state.user.bio;
        if(k === 'link') state.user.link = val || state.user.link;
        if(k === 'avatar') state.user.avatar = val || state.user.avatar;
        if(k === 'highlights') state.user.highlights = val.split(',').map(s => s.trim()).filter(Boolean).slice(0,8);
        if(k === 'grid') state.user.grid = val.split(',').map(s => s.trim()).filter(Boolean).slice(0,9);
        if(k === 'followers') state.user.followers = Number(val) || state.user.followers;
        if(k === 'following') state.user.following = Number(val) || state.user.following;
      });
      state.avatars['@me'] = state.user.avatar;
    }

    function parseKktRooms(text){
      const matches = [...String(text || '').matchAll(/<kkt_room([^>]*)>\s*([\s\S]*?)\s*<\/kkt_room>/g)];
      matches.forEach(m => {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const id = (attrs.match(/id="([^"]+)"/) || [,'room_' + Math.random().toString(36).slice(2,7)])[1];
        const name = (attrs.match(/name="([^"]+)"/) || [,'聊天室'])[1];
        const avatar = (attrs.match(/avatar="([^"]+)"/) || [,''])[1];
        let room = state.rooms.find(r => r.id === id);
        if(!room){ room = {id,name,avatar,preview:'',time:'',unread:0,kind:'单聊'}; state.rooms.push(room); }
        room.name = name || room.name;
        if(avatar) room.avatar = avatar;
        const messages = body.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
          const [side='other', time='00:00', ...rest] = line.split('|');
          const text = rest.join('|').trim();
          return {side: side === 'me' ? 'me' : 'other', name: side === 'me' ? 'me' : room.name, time, text};
        }).filter(msg => msg.text);
        if(messages.length) { state.threads[id] = messages; room.read = false; room.unread = Math.max(room.unread || 0, messages.filter(msg => msg.side !== 'me').length); }
      });
    }

    /**
     * Stable room id from a name (group name or 1v1 partner).
     * Same name => same id => messages merge into the same room.
     */
    function roomIdFromName(name){
      const s = String(name || '').trim();
      if (!s) return 'kkt_default';
      let h = 0;
      for (let i = 0; i < s.length; i++) {
          h = ((h << 5) - h) + s.charCodeAt(i);
          h |= 0;
      }
      return 'kkt_' + Math.abs(h).toString(36);
    }

    /** Dedupe messages by (side, time, text) so two identical adjacent
     *  blocks don't double messages. */
    function dedupeMessages(arr){
      const seen = new Set();
      const out = [];
      for (const m of arr) {
        const key = `${m.side}|${m.time}|${m.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
      return out;
    }

    /**
     * Parse <kakao_chat>...</kakao_chat> blocks per worldbook spec.
     * Multiple blocks with the same group/partner are MERGED into one room
     * (deduped). Different group/partner names produce different rooms.
     */
    function parseKakaoChatBlocks(text){
      const byRoom = new Map(); // id -> {room, messages}
      const matches = [...String(text || '').matchAll(/<kakao_chat>\s*([\s\S]*?)\s*<\/kakao_chat>/g)];

      for (const m of matches) {
        const lines = m[1].split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) continue;

        // Optional group-name header line (anything not starting with ⚫/🟡/ᄀ)
        let groupName = null;
        if (!/^[⚫🟡ᄀ]/u.test(lines[0])) {
          groupName = lines[0].replace(/^\s*\[(?:群聊|KKT群|群)\]\s*/, '').trim() || lines[0];
          lines.shift();
        }

        const blockMessages = [];
        let primaryName = null;
        for (let i = 0; i < lines.length; i++) {
          const head = lines[i];
          const hm = head.match(/^([⚫🟡])\s*([^|]+?)\s*\|\s*(\d{1,2}:\d{2})\s*$/u);
          if (!hm) continue;
          const isMe = hm[1] === '🟡';
          const speaker = hm[2].trim();
          const time = hm[3];
          let body = '';
          for (let j = i + 1; j < lines.length; j++) {
            const b = lines[j];
            if (/^[⚫🟡]/u.test(b)) break;
            const bm = b.match(/^ᄀ\s*(.*)$/);
            if (bm) { body = bm[1].trim(); i = j; break; }
          }
          if (!body) continue;
          if (!isMe && !primaryName) primaryName = speaker;
          blockMessages.push({
            side: isMe ? 'me' : 'other',
            name: isMe ? 'me' : speaker,
            time,
            text: body,
          });
        }

        if (!blockMessages.length && !groupName) continue;

        // Decide which room these messages belong to.
        const roomKey = groupName || primaryName || '聊天室';
        const id = roomIdFromName(roomKey);
        let entry = byRoom.get(id);
        if (!entry) {
          entry = {
            room: {
              id,
              name: roomKey,
              avatar: '',
              preview: '',
              time: '',
              unread: 0,
              kind: groupName ? '群聊' : '单聊',
              read: false,
            },
            messages: [],
          };
          byRoom.set(id, entry);
        }
        // Append; dedupe handled below.
        entry.messages.push(...blockMessages);
      }

      // Finalize each room: dedupe + recompute preview/time/unread.
      const out = [];
      for (const entry of byRoom.values()) {
        entry.messages = dedupeMessages(entry.messages);
        const last = entry.messages[entry.messages.length - 1];
        if (last) {
          entry.room.preview = last.text.slice(0, 60);
          entry.room.time = last.time;
        }
        entry.room.unread = entry.messages.filter(x => x.side !== 'me').length;
        out.push(entry);
      }
      return out;
    }

    function applyImport(text){
      const raw = String(text || '').trim();
      if(!raw) return;
      parseUserProfile(raw);
      parseInsProfiles(raw);
      parseStickerBase(raw);
      // Plan A: local user edits beat the worldbook. After parsing the worldbook,
      // re-apply the persisted user profile so manual changes stick across character switches.
      const persisted = loadPersistedUser();
      if(persisted){
        Object.assign(state.user, persisted);
        if(persisted.avatar) state.avatars['@me'] = persisted.avatar;
      }
      const savedBase = loadPersistedStickerBase();
      if(savedBase) _stickerBase = savedBase;
      const stories = parseStoryBlocks(raw);
      const posts = parseFeedBlocks(raw);
      if(stories.length) state.stories = stories;
      if(posts.length){
        state.posts = posts;
        // Posts count = only the user's own posts. NPC posts don't bump it.
        const userHandle = '@' + state.user.handle.replace(/^@/, '');
        state.user.posts = posts.filter(p => p.handle === userHandle || p.handle === '@me').length;
      }

      // Prefer new <kakao_chat> format; fall back to legacy <kkt_room>
      const kakao = parseKakaoChatBlocks(raw);
      if (kakao.length) {
        // Replace rooms / threads completely with the parsed set (predictable behaviour)
        state.rooms = kakao.map(k => k.room);
        state.threads = {};
        kakao.forEach(k => { state.threads[k.room.id] = k.messages; });
        if (!state.rooms.find(r => r.id === state.currentRoom)) {
          state.currentRoom = state.rooms[0]?.id || state.currentRoom;
        }
      } else {
        parseKktRooms(raw);
      }
      refreshAll();
    }

    function getRoomAvatar(room){
      const saved = state.roomIdentity[room.id];
      if(saved?.avatar) return saved.avatar;
      if(room.avatar) return room.avatar;
      return '';
    }

    function updateRoomPreview(roomId){
      const room = roomById(roomId);
      const thread = state.threads[roomId] || [];
      const last = thread[thread.length - 1];
      if(last){ room.preview = last.text; room.time = last.time || room.time; }
    }

    function goNextStory(){
      if(!state.stories.length) return;
      state.currentStory = (state.currentStory + 1) % state.stories.length;
      renderStories();
      renderStoryViewer();
    }

    function renderStories(){
      const wrap = $('#storiesRow');
      const progress = $('#storyProgress');
      if(!wrap || !progress) return;
      wrap.innerHTML = state.stories.map((story,i)=>{
        const fallback = (story.name || story.handle || '').replace('@','').slice(0,2) || 'ST';
        const label = (story.name || story.handle || '').replace('@','').slice(0,8);
        return `<div class="story-pill" data-story="${i}"><div class="story-ring"><div class="avatar-core" data-avatar="${escapeHtml(story.avatar)}" data-fallback="${escapeHtml(fallback)}"></div></div><span>${escapeHtml(label)}</span></div>`;
      }).join('');
      progress.innerHTML = state.stories.map((_,i)=>`<div class="story-progress"><div class="story-progress-fill" style="width:${i < state.currentStory ? 100 : i === state.currentStory ? 86 : 0}%"></div></div>`).join('');
      $$('#storiesRow [data-story]').forEach(el => el.addEventListener('click', () => { state.currentStory = Number(el.dataset.story); renderStoryViewer(); switchInsPanel('story'); }));
      $$('#storiesRow [data-avatar]').forEach(el => applyAvatar(el, el.dataset.avatar, el.dataset.fallback));
    }

    function renderStoryViewer(){
      renderStories();
      const story = state.stories[state.currentStory] || state.stories[0];
      if(!story) return;
      const sFallback = (story.name || story.handle || 'ST').replace('@','').slice(0,2);
      applyAvatar($('#storyAvatar'), story.avatar, sFallback);
      const handlePart = story.handle ? story.handle + (story.name ? ' · ' + story.name : '') : (story.name || '');
      $('#storyHandle').textContent = handlePart;
      const metaParts = [];
      if(story.time) metaParts.push(story.time);
      if(story.mood) metaParts.push(story.mood);
      metaParts.push(`第 ${state.currentStory + 1}/${state.stories.length} 条`);
      $('#storyMeta').textContent = metaParts.join(' · ');
      const canvas = $('#storyCanvas');
      canvas.style.setProperty('--story-bg', story.bg);
      if(story.mediaUrl){
        canvas.classList.add('has-image');
        canvas.style.setProperty('--story-image', `url("${cssUrl(story.mediaUrl)}")`);
      }else{
        canvas.classList.remove('has-image');
        canvas.style.removeProperty('--story-image');
      }
      $('#storyChips').innerHTML = story.chips.map(ch => `<div class="story-chip ${escapeHtml(ch.type)}">${escapeHtml(ch.text)}</div>`).join('');
    }

    function renderFeed(){
      const list = $('#feedList');
      list.innerHTML = state.posts.map((post, idx) => `
        <article class="post" data-post="${idx}">
          <div class="post-head">
            <div class="post-user">
              <div class="post-avatar-wrap"><div class="avatar-core" data-avatar="${escapeHtml(post.avatar)}" data-fallback="${escapeHtml((post.name || post.handle).slice(0,2))}"></div></div>
              <div class="post-meta"><div class="post-handle">${escapeHtml(post.handle)} · ${escapeHtml(post.name)}</div><div class="post-place">${escapeHtml(post.place)}</div></div>
            </div>
          </div>
          <div class="post-media ${post.mediaUrl ? 'has-image' : ''}" style="--post-bg:${post.bg};${post.mediaUrl ? `--post-image:url('${cssUrl(post.mediaUrl)}')` : ''}"><div class="post-overlay">${escapeHtml(post.overlay)}</div></div>
          <div class="post-actions"><div class="post-actions-left"><span class="icon-btn like-btn">♡</span><span class="icon-btn">💬</span><span class="icon-btn">✦</span></div><span class="icon-btn">⋯</span></div>
          <div class="post-likes">${likesText(post.likes)}</div>
          <div class="post-caption">${escapeHtml(post.caption)}</div>
          <div class="post-comments">${post.comments.map(c => `<div>${escapeHtml(c)}</div>`).join('')}</div>
          <div class="comment-row"><input class="comment-input" placeholder="评论…" /><button class="mini-btn">发布</button></div>
        </article>`).join('');
      $$('#feedList [data-avatar]').forEach(el => applyAvatar(el, el.dataset.avatar, el.dataset.fallback));
      $$('#feedList .post').forEach((postEl, idx) => {
        const likeBtn = postEl.querySelector('.like-btn');
        const likesEl = postEl.querySelector('.post-likes');
        let liked = false; let count = state.posts[idx].likes || 0;
        likeBtn.addEventListener('click', () => {
          liked = !liked; count += liked ? 1 : -1; if(count < 0) count = 0;
          likeBtn.textContent = liked ? '♥' : '♡';
          likeBtn.classList.toggle('liked', liked);
          likesEl.textContent = likesText(count);
        });
        const input = postEl.querySelector('.comment-input');
        const btn = postEl.querySelector('.mini-btn');
        const wrap = postEl.querySelector('.post-comments');
        const submit = () => {
          const value = input.value.trim();
          if(!value) return;
          const div = document.createElement('div');
          const myHandle = '@' + state.user.handle.replace(/^@/, '');
          div.textContent = myHandle + '：' + value;
          wrap.appendChild(div);
          input.value = '';
        };
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); submit(); } });
      });
    }

    function renderProfile(){
      $('#userHandleText').textContent = '@' + state.user.handle.replace(/^@/, '');
      $('#userNameText').textContent = state.user.name;
      $('#userBioText').textContent = state.user.bio;
      $('#userLinkText').textContent = state.user.link;
      $('#userPostsCount').textContent = state.user.posts;
      $('#userFollowersCount').textContent = state.user.followers;
      $('#userFollowingCount').textContent = state.user.following;
      applyAvatar($('#userAvatarMain'), state.user.avatar, 'ME');
      applyAvatar($('#userAvatarPreview'), state.user.avatar, 'ME');
      // "主角色" = first discovered NPC handle (anything other than @me).
      // This used to be hardcoded as @jungsoo_23; now it tracks whoever is
      // actually present in the worldbook / parsed feed.
      const npcHandles = Object.keys(state.avatars).filter(h => h !== '@me');
      const mainHandle = npcHandles[0] || '';
      applyAvatar($('#characterAvatarPreview'), mainHandle ? state.avatars[mainHandle] : '', mainHandle ? mainHandle.replace('@','').slice(0,2).toUpperCase() : 'NPC');
      $('#userAvatarInput').value = state.user.avatar || '';
      const charInput = $('#characterAvatarInput');
      charInput.value = mainHandle ? (state.avatars[mainHandle] || '') : '';
      charInput.placeholder = mainHandle ? `${mainHandle} 的头像 URL` : '主角色头像 URL（先在 INS Feed/Story 出现 @handle 后才能识别）';
      charInput.dataset.targetHandle = mainHandle;
      // Avatar map enumerates ALL discovered handles dynamically.
      $('#avatarMapInput').value = Object.entries(state.avatars).map(([k,v]) => `${k}=${v}`).join('\n');
      $('#avatarMapInput').placeholder = npcHandles.length
        ? npcHandles.slice(0,3).map(h => `${h}=https://...`).join('\n')
        : '@handle=https://...（每行一个，自动从世界书发现）';
      $('#editHandle').value = state.user.handle;
      $('#editName').value = state.user.name;
      $('#editBio').value = state.user.bio;
      $('#editLink').value = state.user.link;
      $('#editHighlights').value = state.user.highlights.join(', ');
      $('#editGridCaptions').value = state.user.grid.join(', ');
      $('#highlightRow').innerHTML = state.user.highlights.map(item => `<div class="highlight-item"><div class="highlight-ring"><div class="highlight-core">${escapeHtml(item.slice(0,4))}</div></div><span>${escapeHtml(item)}</span></div>`).join('');
      $('#profileGrid').innerHTML = Array.from({length:9}).map((_,i) => {
        const post = state.posts[i % Math.max(state.posts.length,1)] || {bg:'linear-gradient(160deg,#111827,#334155)',mediaUrl:''};
        return `<div class="grid-post" style="--thumb-bg:${post.bg};--post-image:${post.mediaUrl ? `url('${cssUrl(post.mediaUrl)}')` : 'none'}"><span>${escapeHtml(state.user.grid[i] || '')}</span></div>`;
      }).join('');
    }

    function renderChatList(){
      state.rooms.forEach(room => updateRoomPreview(room.id));
      $('#chatList').innerHTML = state.rooms.map(room => {
        const avatar = getRoomAvatar(room);
        const title = state.roomIdentity[room.id]?.name || room.name;
        return `<button class="chat-item" data-room="${escapeHtml(room.id)}"><div class="chat-avatar avatar-core" data-avatar="${escapeHtml(avatar)}" data-fallback="${escapeHtml(title.slice(0,2))}"></div><div class="chat-main"><div class="chat-topline"><div class="chat-name">${escapeHtml(title)}</div></div><div class="chat-preview">${escapeHtml(room.preview || '')}</div></div><div class="chat-meta"><div class="chat-time">${escapeHtml(room.time || '')}</div>${room.unread && !room.read ? `<div class="chat-unread">${room.unread}</div>` : ''}</div></button>`;
      }).join('');
      $$('#chatList [data-room]').forEach(el => el.addEventListener('click', () => openRoom(el.dataset.room)));
      $$('#chatList [data-avatar]').forEach(el => applyAvatar(el, el.dataset.avatar, el.dataset.fallback));
    }

    /**
     * Sticker base URL. Override at runtime from settings or worldbook so
     * actual sticker images can render without redeploying. Example:
     *   window.CuiPhone.setStickerBase('https://yourcdn.example.com/stickers/');
     */
    // Default to catbox.moe so users who put `<bqb>desc xxxxxx.gif</bqb>`
    // get pictures right away. Override with <sticker_base>...</sticker_base>
    // in the worldbook or window.CuiPhone.setStickerBase('https://...').
    let _stickerBase = 'https://files.catbox.moe/';

    function renderSticker(inner){
      const trimmed = String(inner || '').trim();
      // 1) Full URL anywhere in the tag wins — pull out http(s) link first.
      const urlMatch = trimmed.match(/(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))/i);
      let url = '';
      let desc = '';
      let file = '';
      if (urlMatch) {
        url = urlMatch[1];
        desc = trimmed.replace(url, '').trim();
      } else {
        // 2) Trailing token that looks like "name.ext" — combine with base.
        const fileMatch = trimmed.match(/(\S+\.(?:png|jpe?g|gif|webp))\s*$/i);
        if (fileMatch) {
          file = fileMatch[1];
          desc = trimmed.slice(0, trimmed.length - file.length).trim();
        } else {
          // 3) Trailing bare catbox ID (6 chars, no extension) — assume .jpg
          //    on catbox. Users can still override with explicit extension.
          const idMatch = trimmed.match(/(?:^|\s)([a-z0-9]{6})\s*$/i);
          if (idMatch && /catbox/i.test(_stickerBase)) {
            file = idMatch[1] + '.jpg';
            desc = trimmed.slice(0, trimmed.length - idMatch[1].length).trim();
          } else {
            desc = trimmed;
          }
        }
        if (file && _stickerBase) {
          url = _stickerBase.replace(/\/?$/, '/') + file;
        }
      }
      if (url) {
        return `<div class="sticker-bubble has-image" title="${escapeHtml(desc || file)}">`
             + `<img class="sticker-img" src="${escapeHtml(url)}" alt="${escapeHtml(desc || file)}" `
             + `onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
             + `<div class="sticker-fallback" style="display:none">`
             + `<div class="sticker-emoji">🎨</div>`
             + `<div class="sticker-desc">${escapeHtml(desc || file || '贴纸')}</div>`
             + `</div></div>`;
      }
      return `<div class="sticker-bubble" title="${escapeHtml(file)}">`
           + `<div class="sticker-emoji">🎨</div>`
           + `<div class="sticker-desc">${escapeHtml(desc || file || '贴纸')}</div>`
           + `</div>`;
    }

    /**
     * Render a single bubble's content.
     *  - Detects <bqb>desc filename.ext</bqb> anywhere in the bubble (one
     *    or many) and renders each as a sticker tile.
     *  - Plain text outside the tags is HTML-escaped and kept inline.
     */
    function renderBubbleContent(text){
      const raw = String(text || '');
      if (!/<bqb>[\s\S]*?<\/bqb>/i.test(raw)) {
        return escapeHtml(raw);
      }
      const parts = [];
      const re = /<bqb>([\s\S]*?)<\/bqb>/gi;
      let last = 0;
      let mm;
      while ((mm = re.exec(raw)) !== null) {
        if (mm.index > last) {
          const seg = raw.slice(last, mm.index).trim();
          if (seg) parts.push(escapeHtml(seg));
        }
        parts.push(renderSticker(mm[1]));
        last = mm.index + mm[0].length;
      }
      if (last < raw.length) {
        const seg = raw.slice(last).trim();
        if (seg) parts.push(escapeHtml(seg));
      }
      return parts.join(' ');
    }

    function renderThread(){
      const room = roomById(state.currentRoom);
      if(!room.id){
        $('#roomName').textContent = '';
        $('#roomSub').textContent = '';
        applyAvatar($('#roomAvatar'), '', '');
        $('#thread').innerHTML = '<div class="day-badge">暂无聊天，贴一段 &lt;kakao_chat&gt; 后会出现</div>';
        return;
      }
      const title = state.roomIdentity[room.id]?.name || room.name;
      $('#roomName').textContent = title;
      $('#roomSub').textContent = room.kind || '聊天';
      applyAvatar($('#roomAvatar'), getRoomAvatar(room), title.slice(0,2));
      const messages = state.threads[room.id] || [];
      const html = messages.length ? messages.map(msg => msg.side === 'me'
        ? `<div class="msg me"><div class="msg-stack"><div class="msg-line"><div class="msg-time">${escapeHtml(msg.time)}</div><div class="bubble">${renderBubbleContent(msg.text)}</div></div></div></div>`
        : `<div class="msg other"><div class="msg-avatar avatar-core" data-avatar="${escapeHtml(getRoomAvatar(room))}" data-fallback="${escapeHtml(title.slice(0,2))}"></div><div class="msg-stack"><div class="msg-name">${escapeHtml(msg.name || title)}</div><div class="msg-line"><div class="bubble">${renderBubbleContent(msg.text)}</div><div class="msg-time">${escapeHtml(msg.time)}</div></div></div></div>`
      ).join('') : '<div class="day-badge">暂无消息</div>';
      $('#thread').innerHTML = `<div class="day-badge">今天</div>${html}`;
      $$('#thread [data-avatar]').forEach(el => applyAvatar(el, el.dataset.avatar, el.dataset.fallback));
      $('#thread').scrollTop = $('#thread').scrollHeight;
    }

    function openRoom(id){ state.currentRoom = id; const room = roomById(id); if(room.id){ room.read = true; room.unread = 0; } renderChatList(); renderThread(); switchKktPanel('chat'); }

    function openCall(){
      const room = roomById(state.currentRoom);
      const title = state.roomIdentity[room.id]?.name || room.name;
      applyAvatar($('#callAvatar'), getRoomAvatar(room), title.slice(0,2));
      $('#callName').textContent = title;
      $('#callState').textContent = '连接中';
      $('#callScreen').classList.add('active');
      clearInterval(state.callTimer);
      state.callSeconds = 0;
      state.callTimer = setInterval(() => {
        state.callSeconds += 1;
        if(state.callSeconds > 2) $('#callState').textContent = `${String(Math.floor(state.callSeconds / 60)).padStart(2,'0')}:${String(state.callSeconds % 60).padStart(2,'0')}`;
      }, 1000);
    }

    function closeCall(backToChat = true){
      $('#callScreen').classList.remove('active');
      clearInterval(state.callTimer);
      state.callTimer = null;
      if(backToChat) switchKktPanel('chat');
    }

    function openRoomEditor(){
      const room = roomById(state.currentRoom);
      $('#roomNameInput').value = state.roomIdentity[room.id]?.name || room.name;
      $('#roomAvatarInput').value = state.roomIdentity[room.id]?.avatar || room.avatar || '';
      $('#roomEditorSheet').classList.remove('collapsed');
    }
    function closeRoomEditor(){ $('#roomEditorSheet').classList.add('collapsed'); }

    function submitKkt(){
      const input = $('#kktInput');
      const text = input.value.trim();
      if(!text) return;
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      if(!state.threads[state.currentRoom]) state.threads[state.currentRoom] = [];
      state.threads[state.currentRoom].push({side:'me',name:'me',time,text});
      updateRoomPreview(state.currentRoom);
      renderChatList();
      renderThread();
      // ★ Bridge: mirror this message into SillyTavern's main composer
      try { window.CuiPhone && window.CuiPhone.sendToST && window.CuiPhone.sendToST(text); } catch(e) { console.warn('[CUI Phone] sendToST failed', e); }
      input.value = '';
    }

    function setComposeMode(mode){
      state.composeMode = mode;
      $$('[data-compose]').forEach(btn => btn.classList.toggle('active', btn.dataset.compose === mode));
      $('#composerLikes').classList.toggle('hidden', mode === 'story');
      $('#composerComments').classList.toggle('hidden', mode === 'story');
    }

    function openComposer(mode='feed'){
      setComposeMode(mode);
      $('#composerMeta').value = mode === 'feed' ? '18:42 我的动态' : '23:41';
      ['composerMedia','composerMediaUrl','composerLikes','composerText','composerComments'].forEach(id => $('#'+id).value = '');
      $('#composerPanel').classList.add('active');
    }
    function closeComposer(){ $('#composerPanel').classList.remove('active'); }

    function publishComposer(){
      const handle = '@' + state.user.handle.replace(/^@/, '');
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const meta = $('#composerMeta').value.trim() || hhmm;
      const media = $('#composerMedia').value.trim() || '[图]';
      const mediaUrl = $('#composerMediaUrl').value.trim();
      const text = $('#composerText').value.trim();
      if(state.composeMode === 'story'){
        const extra = text.split('\n').map(s => s.trim()).filter(Boolean);
        const chips = [media, ...extra].map(line => {
          if(/^\[贴纸/.test(line)) return {type:'sticker',text:line};
          if(/^\[音乐/.test(line)) return {type:'music',text:line.replace(/^\[音乐\s*·?\s*/,'').replace(/\]$/,'')};
          return {type:'text',text:line.replace(/^story\s*字幕[:：]?\s*/i,'')};
        });
        state.stories.unshift({handle,name:state.user.name,time:meta,avatar:state.user.avatar,mediaUrl,bg:'radial-gradient(circle at 50% 18%, rgba(255,255,255,.18), transparent 22%), linear-gradient(160deg,#4338ca,#7c3aed 52%,#1e1b4b)',chips});
        state.currentStory = 0;
        renderStories(); renderStoryViewer(); closeComposer(); switchInsPanel('story');
      }else{
        const comments = $('#composerComments').value.split('\n').map(s => s.trim()).filter(Boolean);
        const likesInput = parseLikes($('#composerLikes').value);
        // No explicit number → 0 (the user's own post; 不需要伪造点赞数).
        const likes = likesInput || 0;
        state.posts.unshift({handle,name:state.user.name,place:meta,likes,caption:text,comments,overlay:media,mediaUrl,avatar:state.user.avatar,bg:'radial-gradient(circle at 50% 16%, rgba(255,255,255,.16), transparent 18%), linear-gradient(160deg,#7c3aed,#ec4899 55%,#312e81)'});
        state.user.posts += 1;
        renderFeed(); renderProfile(); closeComposer(); switchInsPanel('feed');
      }
    }

    function openProfileEditor(){ $('#profileEditor').classList.remove('collapsed'); $('#avatarEditor').classList.remove('collapsed'); $('#openProfileEditBtn').textContent = '正在编辑'; }
    function closeProfileEditor(){ $('#profileEditor').classList.add('collapsed'); $('#avatarEditor').classList.add('collapsed'); $('#openProfileEditBtn').textContent = '编辑主页'; }

    function applyAvatarSettings(){
      state.user.avatar = $('#userAvatarInput').value.trim();
      state.avatars['@me'] = state.user.avatar;
      const charInput = $('#characterAvatarInput');
      const charTarget = charInput.dataset.targetHandle || '';
      const charValue = charInput.value.trim();
      if(charTarget && charValue) state.avatars[charTarget] = charValue;
      $('#avatarMapInput').value.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
        if(!line.includes('=')) return;
        const [key, value] = line.split('=');
        if(key && value) state.avatars[key.trim()] = value.trim();
      });
      state.stories = state.stories.map(story => ({...story, avatar: story.handle === '@' + state.user.handle ? state.user.avatar : (state.avatars[story.handle] || story.avatar)}));
      state.posts = state.posts.map(post => ({...post, avatar: post.handle === '@' + state.user.handle || post.handle === '@me' ? state.user.avatar : (state.avatars[post.handle] || post.avatar)}));
      renderStories(); renderStoryViewer(); renderFeed(); renderProfile(); renderChatList(); renderThread();
      persistUser();
      $('#avatarHint').textContent = '修改后会同步到 Story、Feed、主页与 KKT。';
    }

    function saveProfile(){
      const prevHandle = state.user.handle;
      state.user.handle = $('#editHandle').value.trim().replace(/^@/,'') || state.user.handle;
      state.user.name = $('#editName').value.trim() || state.user.name;
      state.user.bio = $('#editBio').value.trim() || state.user.bio;
      state.user.link = $('#editLink').value.trim() || state.user.link;
      const highlights = $('#editHighlights').value.trim();
      const grid = $('#editGridCaptions').value.trim();
      if(highlights) state.user.highlights = highlights.split(',').map(s => s.trim()).filter(Boolean).slice(0,8);
      if(grid){
        const arr = grid.split(',').map(s => s.trim()).filter(Boolean);
        state.user.grid = Array.from({length:9}).map((_,i) => arr[i] || arr[arr.length - 1] || '');
      }
      state.stories = state.stories.map(story => {
        const own = story.handle === '@' + prevHandle || story.handle === '@' + state.user.handle || story.handle === '@me';
        return own ? {...story, handle:'@' + state.user.handle, name:state.user.name, avatar:state.user.avatar || story.avatar} : story;
      });
      state.posts = state.posts.map(post => {
        const own = post.handle === '@' + prevHandle || post.handle === '@' + state.user.handle || post.handle === '@me';
        return own ? {...post, handle:'@' + state.user.handle, name:state.user.name, avatar:state.user.avatar || post.avatar} : post;
      });
      renderStories(); renderStoryViewer(); renderFeed(); renderProfile(); closeProfileEditor();
      persistUser();
    }

    function resetUserProfile(){
      if(!confirm('重置 user 资料？下次刷新会从世界书 <user_profile> 重读。')) return;
      clearPersistedUser();
      Object.assign(state.user, JSON.parse(JSON.stringify(DEFAULT_USER)));
      state.avatars['@me'] = '';
      // Re-apply imported worldbook data so values come back from <user_profile>.
      try { applyImport(state.defaultImport || ''); } catch(_){}
      renderProfile(); closeProfileEditor();
    }

    function renderLockNotifs(){
      const stack = $('#lockNotifStack');
      if(!stack) return;
      const cards = [];

      // Latest KKT message: scan all rooms, take last NPC message overall.
      let latestKkt = null;
      for(const room of state.rooms){
        const thread = state.threads[room.id] || [];
        for(let i = thread.length - 1; i >= 0; i--){
          const m = thread[i];
          if(m.side === 'me') continue;
          if(!latestKkt || (m.time || '') >= (latestKkt.time || '')){
            latestKkt = {room, msg: m};
          }
          break;
        }
      }
      if(latestKkt){
        const sender = latestKkt.room.kind && latestKkt.room.kind.includes('群')
          ? `${latestKkt.room.name} · ${latestKkt.msg.name || ''}`.trim()
          : (latestKkt.room.name || latestKkt.msg.name || '');
        const preview = (latestKkt.msg.text || '').replace(/<bqb>[\s\S]*?<\/bqb>/gi, '[贴纸]').slice(0, 60);
        cards.push(`<div class="notif-card"><div class="notif-head"><span>KakaoTalk</span><span>${escapeHtml(latestKkt.msg.time || '')}</span></div><div class="notif-title">${escapeHtml(sender)}</div><div class="notif-copy">${escapeHtml(preview)}</div></div>`);
      }

      // Latest INS post.
      const latestPost = state.posts[0];
      if(latestPost){
        const preview = (latestPost.caption || latestPost.overlay || '').slice(0, 60);
        cards.push(`<div class="notif-card"><div class="notif-head"><span>Instagram</span><span>${escapeHtml(latestPost.place || '')}</span></div><div class="notif-title">${escapeHtml(latestPost.handle)} · ${escapeHtml(latestPost.name || '')}</div><div class="notif-copy">${escapeHtml(preview)}</div></div>`);
      }

      // Latest Story.
      const latestStory = state.stories[0];
      if(latestStory && !latestPost){
        const preview = (latestStory.chips.find(c => c.type === 'text')?.text || '').slice(0, 60);
        cards.push(`<div class="notif-card"><div class="notif-head"><span>Instagram Story</span><span>${escapeHtml(latestStory.time || '')}</span></div><div class="notif-title">${escapeHtml(latestStory.handle)} · ${escapeHtml(latestStory.name || '')}</div><div class="notif-copy">${escapeHtml(preview)}</div></div>`);
      }

      stack.innerHTML = cards.join('') || '<div class="unlock-hint" style="opacity:.55">暂无通知</div>';
    }

    function refreshAll(){
      renderStories();
      renderStoryViewer();
      renderFeed();
      renderProfile();
      renderChatList();
      renderThread();
      renderLockNotifs();
      $('#stImportText').value = state.defaultImport;
    }

    function updateClock(){
      const now = new Date();
      const hh = String(now.getHours()).padStart(2,'0');
      const mm = String(now.getMinutes()).padStart(2,'0');
      const days = ['周日','周一','周二','周三','周四','周五','周六'];
      $('#statusTime').textContent = `${hh}:${mm}`;
      $('#lockTime').textContent = `${hh}:${mm}`;
      $('#lockDate').textContent = `${days[now.getDay()]} ${(now.getMonth()+1)}/${now.getDate()}`;
      updateBattery();
    }

    /* ---- Battery: real (navigator.getBattery) when available, fake fallback otherwise ----
     * Real path: read once, then re-read on each tick — the Battery API returns
     * a live object whose .level updates as the OS reports changes. We just
     * re-paint the DOM each second so it stays in sync with `time`.
     * Fallback path: deterministic curve based on wall-clock time so the
     * displayed % drifts down naturally instead of being a static "87%".
     */
    let _batteryObj = null;
    let _batteryReqd = false;
    function ensureBattery(){
      if (_batteryReqd) return;
      _batteryReqd = true;
      try {
        if (navigator.getBattery) {
          navigator.getBattery().then(b => {
            _batteryObj = b;
            // re-paint immediately on any change
            const repaint = () => paintBattery();
            b.addEventListener && b.addEventListener('levelchange', repaint);
            b.addEventListener && b.addEventListener('chargingchange', repaint);
            paintBattery();
          }).catch(() => {});
        }
      } catch(_){}
    }
    function fakeBatteryPct(){
      // Tied to clock so it slowly cycles 100→40 over 24h, then jumps back.
      // Charging "animation" uses the seconds digit so the bar visibly breathes.
      const now = new Date();
      const minutes = now.getHours()*60 + now.getMinutes();
      const dayFrac = minutes / (24*60);                    // 0→1
      const base = Math.round(100 - dayFrac * 60);          // 100 → 40
      // Add a small jitter so the % feels alive (±1% via seconds).
      const jitter = (now.getSeconds() % 7 === 0) ? -1 : 0;
      return Math.max(20, Math.min(100, base + jitter));
    }
    function paintBattery(){
      const pctEl = document.getElementById('statusBatteryPct');
      const fillEl = document.getElementById('statusBatteryFill');
      const wrapEl = document.getElementById('statusBattery');
      if (!pctEl || !fillEl || !wrapEl) return;
      let pct, charging = false;
      if (_batteryObj && typeof _batteryObj.level === 'number') {
        pct = Math.round(_batteryObj.level * 100);
        charging = !!_batteryObj.charging;
      } else {
        pct = fakeBatteryPct();
      }
      pctEl.textContent = pct + '%';
      // Battery shell inner width is 21px (24 - 2*1.5 border padding); fill is 15px at 100%.
      // Match the original look: 100% -> ~15px. We scale linearly.
      const maxW = 15;
      const w = Math.max(2, Math.round(maxW * pct / 100));
      fillEl.style.width = w + 'px';
      // Color by level: low=red, mid=white (default), charging=green tint.
      let color = '#fff';
      if (charging) color = '#34d399';
      else if (pct <= 20) color = '#ff5a5f';
      fillEl.style.background = color;
      wrapEl.title = charging ? `充电中 ${pct}%` : `电量 ${pct}%`;
    }
    function updateBattery(){
      ensureBattery();
      paintBattery();
    }

    function bindUI(){
      $('[data-view="lock"]').addEventListener('click', () => switchView('home'));
      $$('[data-open-app]').forEach(btn => btn.addEventListener('click', () => {
        const app = btn.dataset.openApp;
        if(app === 'ins'){ switchView('ins'); switchInsPanel('feed'); }
        if(app === 'kkt'){ switchView('kkt'); switchKktPanel('list'); renderChatList(); }
        if(app === 'st'){ switchView('st'); }
      }));
      $$('[data-home]').forEach(btn => btn.addEventListener('click', () => {
        if(state.currentView === 'ins'){
          if(state.currentInsPanel === 'story'){ switchInsPanel('feed'); return; }
          if(state.currentInsPanel === 'profile'){ closeProfileEditor(); switchInsPanel('feed'); return; }
        }
        if(state.currentView === 'kkt'){
          if($('#callScreen').classList.contains('active')){ closeCall(true); return; }
          if(state.currentKktPanel === 'chat'){ $('#emojiSheet').classList.add('collapsed'); closeRoomEditor(); switchKktPanel('list'); return; }
          closeRoomEditor();
        }
        switchView('home');
      }));
      $$('.ins-tab').forEach(btn => btn.addEventListener('click', () => switchInsPanel(btn.dataset.insTab)));
      $('#storyLikeBtn').addEventListener('click', e => { e.currentTarget.textContent = e.currentTarget.textContent === '♡' ? '♥' : '♡'; });
      const sendStoryReply = () => { const input = $('#storyReplyInput'); if(!input.value.trim()) return; input.value=''; };
      $('#storySendBtn').addEventListener('click', sendStoryReply);
      $('#storyReplyInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); sendStoryReply(); } });
      const storyCanvas = $('#storyCanvas');
      storyCanvas.addEventListener('click', e => { if(e.clientX > window.innerWidth / 2) goNextStory(); });
      storyCanvas.addEventListener('touchstart', e => { state.storyStartX = e.touches[0].clientX; }, {passive:true});
      storyCanvas.addEventListener('touchend', e => { const dx = state.storyStartX - e.changedTouches[0].clientX; if(dx > 36) goNextStory(); });
      $('#openComposerBtn').addEventListener('click', () => openComposer(state.currentInsPanel === 'story' ? 'story' : 'feed'));
      $$('.composer-tab').forEach(btn => btn.addEventListener('click', () => setComposeMode(btn.dataset.compose)));
      $('#closeComposerBtn').addEventListener('click', closeComposer);
      $('#publishComposerBtn').addEventListener('click', publishComposer);
      $('#openProfileEditBtn').addEventListener('click', openProfileEditor);
      $('#cancelProfileEditBtn').addEventListener('click', () => { closeProfileEditor(); renderProfile(); });
      $('#applyAvatarBtn').addEventListener('click', applyAvatarSettings);
      $('#saveProfileBtn').addEventListener('click', saveProfile);
      const resetBtn = $('#resetProfileBtn');
      if(resetBtn) resetBtn.addEventListener('click', resetUserProfile);
      $('#sendKktBtn').addEventListener('click', submitKkt);
      $('#kktInput').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); submitKkt(); } });
      $('#callRoomBtn').addEventListener('click', openCall);
      $('#editRoomBtn').addEventListener('click', openRoomEditor);
      $('#cancelRoomEditBtn').addEventListener('click', closeRoomEditor);
      $('#saveRoomEditBtn').addEventListener('click', () => {
        const room = roomById(state.currentRoom);
        state.roomIdentity[room.id] = {name: $('#roomNameInput').value.trim() || room.name, avatar: $('#roomAvatarInput').value.trim() || ''};
        renderChatList(); renderThread(); closeRoomEditor();
      });
      ['openImportBtn','openImportBtnTop'].forEach(id => {
        const el = root.querySelector('#' + (id)); if(el) el.addEventListener('click', () => switchView('st'));
      });
      $('#openEmojiSheetBtn').addEventListener('click', () => { $('#emojiSheet').classList.remove('collapsed'); closeRoomEditor(); });
      $('#closeEmojiSheetBtn').addEventListener('click', () => $('#emojiSheet').classList.add('collapsed'));
      $$('.emoji-btn').forEach(btn => btn.addEventListener('click', () => { $('#kktInput').value += btn.textContent; $('#emojiSheet').classList.add('collapsed'); $('#kktInput').focus(); }));
      $$('.sticker-btn').forEach(btn => btn.addEventListener('click', () => { $('#kktInput').value = btn.textContent.replace(/\s*\(贴纸\)/,''); $('#emojiSheet').classList.add('collapsed'); }));
      $('#applyImportBtn').addEventListener('click', () => { state.defaultImport = $('#stImportText').value; applyImport(state.defaultImport); });
      $('#applyImportBtnTop').addEventListener('click', () => { state.defaultImport = $('#stImportText').value; applyImport(state.defaultImport); });
      $('#resetImportBtn').addEventListener('click', () => { state.defaultImport = defaultImportText; $('#stImportText').value = defaultImportText; applyImport(defaultImportText); });
      $('#muteCallBtn').addEventListener('click', e => e.currentTarget.classList.toggle('active'));
      $('#speakerCallBtn').addEventListener('click', e => e.currentTarget.classList.toggle('active'));
      $('#endCallBtn').addEventListener('click', () => closeCall(true));
      $('#backCallBtn').addEventListener('click', () => closeCall(true));
    }

    function applyPersistedUser(){
      // Local user profile (Plan A) overrides whatever was just parsed from worldbook,
      // so the user's manual edits stick across character switches and reloads.
      const persisted = loadPersistedUser();
      if(persisted){
        Object.assign(state.user, persisted);
        if(persisted.avatar) state.avatars['@me'] = persisted.avatar;
      }
      const savedBase = loadPersistedStickerBase();
      if(savedBase) _stickerBase = savedBase;
    }

    function init(){
      state.defaultImport = defaultImportText;
      $('#stImportText').value = defaultImportText;
      // applyImport already merges persisted user state at the end.
      applyImport(defaultImportText);
      applyPersistedUser();
      bindUI();
      updateClock();
      setInterval(updateClock, 1000);
      switchView('lock');
      switchInsPanel('feed');
      switchKktPanel('list');
      try { renderProfile(); } catch(_){}
    }


    // ===== Bridge surface for SillyTavern integration =====
    function refreshFromST({ character, chat } = {}) {
      try {
        if (character && character.name) {
          const room = state.rooms[0];
          if (room) {
            room.name = character.name;
            state.roomIdentity[room.id] = {
              name: character.name,
              avatar: character.avatar || ''
            };
          }
        }
        if (Array.isArray(chat)) {
          const room = state.rooms[0];
          if (room) {
            const charName = character?.name || room.name;
            state.threads[room.id] = chat.map(m => ({
              side: m.is_user ? 'me' : 'other',
              name: m.is_user ? 'me' : (m.from || charName),
              time: (typeof m.time === 'string' && m.time.length >= 5) ? m.time.slice(11,16) : '',
              text: m.text || ''
            }));
            const last = chat[chat.length - 1];
            if (last) {
              room.preview = (last.text || '').slice(0, 40);
              room.time = 'now';
              room.unread = 0;
              room.read = true;
            }
          }
        }
        renderChatList();
        renderThread();
      } catch (e) {
        console.error('[CUI Phone] refreshFromST internal error', e);
      }
    }

    // Expose API for st-bridge.js / external callers
    window.CuiPhone = {
      state,
      applyImport,
      switchView,
      switchKktPanel,
      switchInsPanel,
      renderChatList,
      renderThread,
      renderInstagramFeed: renderFeed,
      openPhonePanel:  () => document.getElementById('cui-phone-root')?.classList.remove('cui-collapsed'),
      closePhonePanel: () => document.getElementById('cui-phone-root')?.classList.add('cui-collapsed'),
      refreshFromST,
      setStickerBase: (url) => { _stickerBase = String(url || '').trim(); persistStickerBase(); refreshAll(); },
      getStickerBase: () => _stickerBase,
      // sendToST() is injected by st-bridge.js
    };

    init();

}

window.__cuiPhoneMount = mountPhoneUI;


// ===== index.js (adapted) =====
/* =====================================================================
 * CUI Phone — extension entry point
 * ---------------------------------------------------------------------
 * Mounts an in-page floating phone panel into SillyTavern, loads the
 * original clean-HTML phone UI, and wires it to ST's chat data.
 * ===================================================================== */


const MODULE_NAME = 'cui_phone';

/** Resolve the extension's own base URL at runtime, no matter where it's installed. */
const EXT_PATH = (() => {
    try {
        // import.meta.url is the absolute URL of THIS file (index.js).
        // Strip the filename to get the directory.
        const u = new URL('.', import.meta.url);
        return u.pathname.replace(/\/$/, '');
    } catch (e) {
        // Fallback for older bundlers that don't expose import.meta
        return '/scripts/extensions/third-party/Extension-CuiPhone';
    }
})();
console.log('[CUI Phone] EXT_PATH =', EXT_PATH);

/** Inject inner phone CSS once (scoped under #cui-phone-root).
 *  Uses fetch+<style> rather than <link> so we can see the failure mode
 *  loudly (404 -> visible error in console + on-screen banner) and so the
 *  styles survive any path/serving quirk where ST doesn't expose the file
 *  via the static route.
 */
async function injectInnerCss() {
    if (document.getElementById('cui-phone-inner-css')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'cui-phone-inner-css';
    styleEl.textContent = "/* CUI Phone — inner phone-shell styles, all scoped under #cui-phone-root */\n\n    #cui-phone-root{\n      --bg:#dfe6f1;--shell:#101319;--screen:#f6f8fc;--text:#0f172a;--muted:#64748b;--line:rgba(15,23,42,.08);\n      --surface:#ffffff;--surface-soft:#f8fafc;--ios-blue:#0a84ff;--ins-grad:linear-gradient(135deg,#f9ce34 0,#ee2a7b 52%,#6228d7 100%);\n      --kkt:#fae100;--shadow:0 25px 70px rgba(15,23,42,.22);\n    }\n    #cui-phone-root *{box-sizing:border-box;margin:0;padding:0}\n    #cui-phone-root button, #cui-phone-root input, #cui-phone-root textarea{font:inherit}\n    #cui-phone-root .phone-shell{width:min(100%,392px);background:linear-gradient(180deg,#1a1d25 0,#0d0f13 100%);border-radius:42px;padding:10px;box-shadow:var(--shadow), inset 0 0 0 1px rgba(255,255,255,.06);position:relative}\n    #cui-phone-root .dynamic-island{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:126px;height:29px;background:#050608;border-radius:0 0 18px 18px;z-index:50}\n    #cui-phone-root .screen{height:min(84svh,812px);min-height:736px;border-radius:34px;overflow:hidden;position:relative;background:#0f172a}\n    #cui-phone-root .wallpaper{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(4,8,18,.14),rgba(4,8,18,.44)),radial-gradient(circle at 30% 30%,rgba(96,165,250,.36),transparent 34%),radial-gradient(circle at 70% 52%,rgba(244,114,182,.24),transparent 28%),linear-gradient(160deg,#13233d 0,#203961 30%,#30497a 52%,#1b2542 100%)}\n    #cui-phone-root .statusbar{position:absolute;top:0;left:0;right:0;height:48px;padding:13px 28px 0;display:flex;justify-content:space-between;align-items:flex-start;color:#fff;font-size:12px;font-weight:700;z-index:40;pointer-events:none}\n    #cui-phone-root .status-right{display:flex;gap:8px;align-items:center}#cui-phone-root .battery{width:24px;height:12px;border-radius:4px;border:1.7px solid rgba(255,255,255,.92);position:relative}#cui-phone-root .battery::after{content:'';position:absolute;right:-3px;top:3px;width:2px;height:5px;border-radius:3px;background:#fff}#cui-phone-root .battery-fill{position:absolute;left:1.5px;top:1.4px;width:15px;height:6.6px;border-radius:2px;background:#fff}\n    #cui-phone-root .home-indicator{position:absolute;left:50%;transform:translateX(-50%);bottom:8px;width:138px;height:5px;border-radius:999px;background:rgba(0,0,0,.84);z-index:40;pointer-events:none}\n    #cui-phone-root .view{position:absolute;inset:0;opacity:0;visibility:hidden;pointer-events:none;transform:scale(1.02);transition:opacity .28s ease,transform .28s ease;z-index:5}#cui-phone-root .view.active{opacity:1;visibility:visible;pointer-events:auto;transform:scale(1)}\n\n    #cui-phone-root .lock-view{padding:58px 18px 16px;display:flex;flex-direction:column;justify-content:space-between;color:#fff}\n    #cui-phone-root .lock-top{text-align:center;margin-top:46px}#cui-phone-root .lock-date{font-size:.92rem;font-weight:600;opacity:.94}#cui-phone-root .lock-time{font-size:5rem;line-height:.95;font-weight:300;letter-spacing:-.08em;margin-top:6px}\n    #cui-phone-root .notif-stack{display:grid;gap:12px}#cui-phone-root .notif-card{background:rgba(255,255,255,.18);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:14px 15px}#cui-phone-root .notif-head{display:flex;justify-content:space-between;align-items:center;font-size:.73rem;color:rgba(255,255,255,.86);font-weight:700}#cui-phone-root .notif-title{margin-top:7px;font-size:.92rem;font-weight:800}#cui-phone-root .notif-copy{margin-top:5px;font-size:.84rem;line-height:1.55;color:rgba(255,255,255,.86)}#cui-phone-root .unlock-hint{text-align:center;font-size:.84rem;color:rgba(255,255,255,.9);padding-bottom:12px}\n\n    #cui-phone-root .home-view{padding:58px 16px 18px;color:#fff}#cui-phone-root .home-layout{height:100%;display:flex;flex-direction:column;justify-content:space-between}#cui-phone-root .home-head{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 4px 18px}#cui-phone-root .home-title{font-size:1rem;font-weight:700}#cui-phone-root .home-sub{font-size:.78rem;color:rgba(255,255,255,.8);margin-top:5px}#cui-phone-root .icon-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px 12px}#cui-phone-root .app-slot{display:grid;justify-items:center;gap:8px}#cui-phone-root .app-button{border:none;background:none;color:#fff;cursor:pointer;display:grid;justify-items:center;gap:8px}#cui-phone-root .icon-tile{width:62px;height:62px;border-radius:18px;display:grid;place-items:center;font-weight:800;font-size:1rem;box-shadow:0 12px 24px rgba(15,23,42,.18);overflow:hidden}#cui-phone-root .icon-tile.ins{background:var(--ins-grad)}#cui-phone-root .icon-tile.kkt{background:var(--kkt);color:#111827}#cui-phone-root .icon-tile.memo{background:linear-gradient(180deg,#fff7c2,#fff)}#cui-phone-root .icon-label{font-size:.74rem;text-shadow:0 1px 2px rgba(0,0,0,.25)}#cui-phone-root .dock{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:14px;margin:0 6px 8px;background:rgba(255,255,255,.16);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.14);border-radius:28px}#cui-phone-root .dock .icon-tile{width:58px;height:58px;border-radius:16px}\n\n    #cui-phone-root .app-view{background:#f5f7fb;color:var(--text)}\n    #cui-phone-root .app-topbar{height:88px;padding:44px 14px 10px;display:flex;align-items:flex-end;justify-content:space-between;background:rgba(255,255,255,.94);backdrop-filter:blur(20px);border-bottom:1px solid var(--line);position:relative;z-index:12}#cui-phone-root .app-left{display:flex;align-items:center;gap:10px}#cui-phone-root .icon-circle, #cui-phone-root .nav-btn{width:34px;height:34px;border:none;border-radius:17px;background:#eef2f7;color:#111827;font-size:1rem;font-weight:800;display:grid;place-items:center;cursor:pointer}#cui-phone-root .app-title{font-size:1rem;font-weight:800}#cui-phone-root .app-subline{margin-top:4px;font-size:.74rem;color:var(--muted)}\n    #cui-phone-root .panel{position:absolute;left:0;right:0;top:88px;bottom:58px;display:none;overflow:auto;background:#fff}#cui-phone-root .panel.active{display:block}#cui-phone-root .panel::-webkit-scrollbar{width:0}\n\n    #cui-phone-root .ins-tabs{position:absolute;left:0;right:0;bottom:0;height:58px;background:rgba(255,255,255,.96);border-top:1px solid #eef0f3;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:8px 14px;z-index:14}#cui-phone-root .ins-tab{border:none;border-radius:14px;background:transparent;color:#64748b;font-size:.8rem;font-weight:800;cursor:pointer}#cui-phone-root .ins-tab.active{background:#111827;color:#fff}\n    #cui-phone-root .stories-row{display:flex;gap:12px;padding:12px 12px 14px;overflow:auto;border-bottom:1px solid #eef0f3;background:#fff}#cui-phone-root .stories-row::-webkit-scrollbar{height:0}#cui-phone-root .story-pill{display:grid;justify-items:center;gap:6px;min-width:70px;cursor:pointer}#cui-phone-root .story-ring{width:66px;height:66px;border-radius:50%;padding:2px;background:var(--ins-grad)}#cui-phone-root .avatar-core{width:100%;height:100%;border-radius:50%;background:#fff;display:grid;place-items:center;font-weight:800;color:#334155;overflow:hidden;background-size:cover;background-position:center;background-repeat:no-repeat}#cui-phone-root .avatar-core.has-image{color:transparent;font-size:0;background-color:#e5e7eb}#cui-phone-root .story-pill span{font-size:.73rem;color:#374151;max-width:68px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n    #cui-phone-root .feed-list{padding-bottom:20px}#cui-phone-root .post{background:#fff;border-bottom:1px solid #eef0f3}#cui-phone-root .post-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;gap:10px}#cui-phone-root .post-user{display:flex;align-items:center;gap:10px}#cui-phone-root .post-avatar-wrap{width:36px;height:36px;border-radius:50%;padding:2px;background:var(--ins-grad)}#cui-phone-root .post-meta{min-width:0}#cui-phone-root .post-handle{font-size:.84rem;font-weight:700}#cui-phone-root .post-place{font-size:.72rem;color:#6b7280;margin-top:2px}#cui-phone-root .post-media{aspect-ratio:1/1;position:relative;overflow:hidden;background:linear-gradient(160deg,#111827,#1f2937);display:grid;place-items:end stretch;color:#fff}#cui-phone-root .post-media::before{content:'';position:absolute;inset:0;background:var(--post-bg);background-size:cover;background-position:center}#cui-phone-root .post-media.has-image::before{background-image:var(--post-image),var(--post-bg)}#cui-phone-root .post-overlay{position:relative;z-index:1;padding:18px 16px;background:linear-gradient(180deg,rgba(0,0,0,0) 0,rgba(0,0,0,.68) 100%);font-size:.88rem;line-height:1.6;white-space:pre-line}#cui-phone-root .post-actions{display:flex;justify-content:space-between;align-items:center;padding:10px 12px 8px}#cui-phone-root .post-actions-left{display:flex;gap:14px}#cui-phone-root .icon-btn{font-size:1.24rem;cursor:pointer;user-select:none}#cui-phone-root .icon-btn.liked{color:#ed4956}#cui-phone-root .post-likes{padding:0 12px;font-size:.84rem;font-weight:700}#cui-phone-root .post-caption{padding:6px 12px 4px;font-size:.84rem;line-height:1.55;white-space:pre-line}#cui-phone-root .post-comments{padding:0 12px 10px;font-size:.8rem;color:#374151;display:grid;gap:6px}#cui-phone-root .comment-row{display:flex;gap:8px;padding:0 12px 14px}#cui-phone-root .comment-input{flex:1;height:34px;border:1px solid #e5e7eb;border-radius:17px;padding:0 12px;background:#fafafa;font-size:.82rem;outline:none}#cui-phone-root .mini-btn{border:none;background:none;color:#0095f6;font-weight:800;cursor:pointer}\n    #cui-phone-root .story-panel{background:linear-gradient(180deg,#161b2a 0,#0f1320 100%);color:#fff}#cui-phone-root .story-view{min-height:100%;position:relative;padding:10px 12px 86px}#cui-phone-root .story-progress-wrap{display:flex;gap:4px;padding-top:4px}#cui-phone-root .story-progress{flex:1;height:3px;border-radius:999px;background:rgba(255,255,255,.2);overflow:hidden}#cui-phone-root .story-progress-fill{height:100%;background:#fff;width:0}#cui-phone-root .story-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 2px 12px}#cui-phone-root .story-user{display:flex;align-items:center;gap:10px;min-width:0}#cui-phone-root .story-user .story-ring{width:38px;height:38px}#cui-phone-root .story-name{font-size:.85rem;font-weight:700}#cui-phone-root .story-time{font-size:.75rem;color:rgba(255,255,255,.72);margin-top:2px}#cui-phone-root .story-canvas{margin-top:6px;min-height:420px;border-radius:30px;padding:18px;display:flex;align-items:flex-end;background:var(--story-bg);position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.12);touch-action:pan-y}#cui-phone-root .story-canvas::before{content:'';position:absolute;inset:0;background:var(--story-bg);background-size:cover;background-position:center}#cui-phone-root .story-canvas.has-image::before{background-image:var(--story-image),var(--story-bg)}#cui-phone-root .story-canvas::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.46))}#cui-phone-root .story-chips{position:relative;z-index:2;display:grid;gap:10px;max-width:90%}#cui-phone-root .story-chip{display:inline-flex;max-width:100%;padding:9px 12px;border-radius:16px;font-size:.85rem;line-height:1.5;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.14);white-space:pre-line}#cui-phone-root .story-chip.music{background:rgba(168,85,247,.24)}#cui-phone-root .story-chip.sticker{background:rgba(0,0,0,.3)}#cui-phone-root .story-reply{position:absolute;left:12px;right:12px;bottom:12px;display:flex;gap:10px;align-items:center;padding:8px 10px 8px 14px;border-radius:24px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(16px)}#cui-phone-root .story-reply input{flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:.9rem}#cui-phone-root .story-reply input::placeholder{color:rgba(255,255,255,.75)}#cui-phone-root .story-send{min-width:48px;height:34px;border:none;border-radius:17px;background:rgba(255,255,255,.16);color:#fff;font-size:.82rem;font-weight:800;cursor:pointer}\n    #cui-phone-root .profile-panel{background:#fff}#cui-phone-root .profile-header{padding:16px 14px 10px;border-bottom:1px solid #eef0f3}#cui-phone-root .profile-main{display:grid;grid-template-columns:92px 1fr;gap:14px;align-items:start}#cui-phone-root .profile-avatar{width:92px;height:92px;border-radius:50%;padding:2px;background:var(--ins-grad)}#cui-phone-root .profile-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;margin-top:8px}#cui-phone-root .stat-num{font-weight:800}#cui-phone-root .stat-label{font-size:.72rem;color:#6b7280;margin-top:3px}#cui-phone-root .profile-bio{margin-top:12px;font-size:.84rem;line-height:1.6}#cui-phone-root .profile-link{color:#0a84ff;margin-top:4px}#cui-phone-root .highlight-row{display:flex;gap:14px;overflow:auto;padding:14px 14px 16px;border-bottom:1px solid #eef0f3;background:#fff}#cui-phone-root .highlight-row::-webkit-scrollbar{height:0}#cui-phone-root .highlight-item{display:grid;justify-items:center;gap:7px;min-width:72px}#cui-phone-root .highlight-ring{width:68px;height:68px;border-radius:50%;padding:3px;background:#eef2f7}#cui-phone-root .highlight-core{width:100%;height:100%;border-radius:50%;background:linear-gradient(160deg,#f8fafc,#e2e8f0);display:grid;place-items:center;font-size:.75rem;font-weight:800;color:#475569;padding:8px;text-align:center;line-height:1.2}#cui-phone-root .highlight-item span{font-size:.72rem;color:#475569;max-width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#cui-phone-root .profile-tools, #cui-phone-root .editor-box{padding:14px;border-bottom:1px solid #eef0f3;background:#fff}#cui-phone-root .tool-row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}#cui-phone-root .tool-btn{height:34px;padding:0 16px;border:none;border-radius:17px;font-size:.8rem;font-weight:800;cursor:pointer}#cui-phone-root .tool-btn.primary{background:#111827;color:#fff}#cui-phone-root .tool-btn.secondary{background:#e9eef5;color:#111827}#cui-phone-root .editor-box{display:grid;gap:10px}#cui-phone-root .editor-box.collapsed{display:none}#cui-phone-root .editor-title{font-size:.82rem;font-weight:800;color:#374151}#cui-phone-root .text-input, #cui-phone-root .text-area{width:100%;border:1px solid #e5e7eb;border-radius:16px;padding:12px;background:#fafafa;font:inherit;font-size:.82rem;outline:none}#cui-phone-root .text-area{min-height:90px;resize:vertical}#cui-phone-root .avatar-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}#cui-phone-root .avatar-preview-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}#cui-phone-root .avatar-card{padding:12px;border:1px solid #e5e7eb;border-radius:16px;background:#fafafa;display:grid;justify-items:center;gap:8px}#cui-phone-root .avatar-card .avatar-core{width:56px;height:56px}#cui-phone-root .tiny-label{font-size:.74rem;color:#64748b;font-weight:700}#cui-phone-root .save-hint{font-size:.76rem;color:#0f766e;font-weight:700}#cui-phone-root .profile-grid-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#fff;font-size:.82rem;font-weight:800;border-bottom:1px solid #eef0f3}#cui-phone-root .profile-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:#eef0f3}#cui-phone-root .grid-post{position:relative;aspect-ratio:1/1;background:var(--thumb-bg);display:flex;align-items:flex-end;padding:10px;overflow:hidden}#cui-phone-root .grid-post::before{content:'';position:absolute;inset:0;background:var(--thumb-bg);background-image:var(--post-image);background-size:cover;background-position:center}#cui-phone-root .grid-post::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.42))}#cui-phone-root .grid-post span{position:relative;z-index:1;font-size:.74rem;font-weight:700;color:#fff;line-height:1.35}\n\n    #cui-phone-root .kkt-list{height:100%;overflow:auto;background:#fff}#cui-phone-root .chat-item{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#fff;border:none;border-bottom:1px solid #eef0f3;cursor:pointer;width:100%;text-align:left}#cui-phone-root .chat-avatar{width:50px;height:50px;border-radius:18px;background:#f3f4f6;overflow:hidden;flex:0 0 50px}#cui-phone-root .chat-main{min-width:0;flex:1;display:flex;flex-direction:column}#cui-phone-root .chat-topline{display:flex;justify-content:space-between;align-items:center}#cui-phone-root .chat-name{font-size:.92rem;font-weight:800}#cui-phone-root .chat-preview{font-size:.82rem;color:#6b7280;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#cui-phone-root .chat-meta{display:grid;justify-items:end;gap:8px}#cui-phone-root .chat-time{font-size:.72rem;color:#94a3b8}#cui-phone-root .chat-unread{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#fae100;color:#111827;display:grid;place-items:center;font-size:.72rem;font-weight:800}\n    #cui-phone-root .kkt-chat{display:flex;flex-direction:column;height:100%;background:#b7c8d8}#cui-phone-root .kkt-hero{display:grid;grid-template-columns:52px 1fr 38px 38px;align-items:center;gap:10px;padding:8px 12px;background:#ffe100;border-bottom:1px solid rgba(0,0,0,.06)}#cui-phone-root .kkt-hero-btn{width:34px;height:34px;border:none;border-radius:17px;background:rgba(255,255,255,.36);font-size:.92rem;font-weight:800;color:#20242c;display:grid;place-items:center;cursor:pointer}#cui-phone-root .kkt-hero-avatar{width:44px;height:44px;border-radius:15px;background:#fff8b5;overflow:hidden}#cui-phone-root .kkt-hero-name{font-size:.96rem;font-weight:800;color:#20242c}#cui-phone-root .kkt-hero-sub{font-size:.72rem;color:rgba(32,36,44,.64);margin-top:2px}#cui-phone-root .thread{flex:1;overflow:auto;padding:12px 12px 10px;display:flex;flex-direction:column;gap:10px;min-height:0}#cui-phone-root .thread::-webkit-scrollbar{width:0}#cui-phone-root .day-badge{align-self:center;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.55);font-size:.74rem;color:#52606d}#cui-phone-root .msg{display:flex;gap:8px;max-width:100%;align-items:flex-end}#cui-phone-root .msg.other{justify-content:flex-start}#cui-phone-root .msg.me{justify-content:flex-end}#cui-phone-root .msg-avatar{width:34px;height:34px;border-radius:12px;background:#8ca3b5;overflow:hidden;flex:0 0 34px}#cui-phone-root .msg-stack{display:flex;flex-direction:column;gap:4px;max-width:78%}#cui-phone-root .msg-name{font-size:.72rem;color:rgba(33,40,48,.68);margin-left:2px}#cui-phone-root .msg-line{display:flex;align-items:flex-end;gap:6px}#cui-phone-root .msg.me .msg-line{justify-content:flex-end}#cui-phone-root .msg.other .msg-line{justify-content:flex-start}#cui-phone-root .bubble{padding:10px 12px;border-radius:15px;font-size:.84rem;line-height:1.45;word-break:break-word;box-shadow:0 1px 0 rgba(0,0,0,.04)}#cui-phone-root .msg.other .bubble{background:#fff;color:#20242c;border-top-left-radius:6px}#cui-phone-root .msg.me .bubble{background:#ffe812;color:#20242c;border-top-right-radius:6px}#cui-phone-root .msg-time{font-size:.68rem;color:rgba(52,60,70,.58);white-space:nowrap}#cui-phone-root .inputbar{height:54px;background:#eef1f4;border-top:1px solid rgba(0,0,0,.06);display:flex;align-items:center;gap:8px;padding:0 10px;flex:0 0 54px}#cui-phone-root .input-shell{flex:1;height:36px;border-radius:18px;background:#fff;display:flex;align-items:center;padding:0 12px;border:1px solid rgba(0,0,0,.05)}#cui-phone-root .input-shell input{width:100%;border:none;background:transparent;outline:none;font-size:.84rem;color:#20242c}#cui-phone-root .plus-btn, #cui-phone-root .send-btn{height:34px;border:none;border-radius:17px;padding:0 12px;font-size:.8rem;font-weight:800;cursor:pointer}#cui-phone-root .plus-btn{background:#fff;color:#20242c;min-width:38px}#cui-phone-root .send-btn{background:#ffe100;color:#20242c;min-width:54px}#cui-phone-root .emoji-sheet{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;padding-top:4px}#cui-phone-root .emoji-btn{height:38px;border:none;border-radius:14px;background:#f8fafc;font-size:1.1rem;cursor:pointer}#cui-phone-root .sticker-list{display:grid;grid-template-columns:1fr 1fr;gap:10px}#cui-phone-root .sticker-btn{min-height:42px;padding:10px 12px;border:none;border-radius:14px;background:#f8fafc;font-size:.8rem;font-weight:800;color:#334155;cursor:pointer}\n    #cui-phone-root .sheet{position:absolute;left:0;right:0;bottom:0;padding:16px;background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.99));backdrop-filter:blur(18px);border-top-left-radius:28px;border-top-right-radius:28px;box-shadow:0 -18px 40px rgba(17,24,39,.16);z-index:22}#cui-phone-root .sheet.collapsed{display:none}#cui-phone-root .sheet-handle{width:44px;height:5px;border-radius:999px;background:#cbd5e1;margin:0 auto 12px}#cui-phone-root .sheet-card{display:grid;gap:12px}#cui-phone-root .sheet-title{font-size:.96rem;font-weight:800}#cui-phone-root .sheet-sub{font-size:.78rem;line-height:1.6;color:#64748b}#cui-phone-root .sheet-row{display:grid;gap:10px}#cui-phone-root .sheet-input{width:100%;height:42px;border:1px solid #dbe3ef;border-radius:14px;padding:0 12px;background:#fff;font:inherit;outline:none}#cui-phone-root .sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n    #cui-phone-root .call-screen{position:absolute;inset:88px 0 0;background:linear-gradient(180deg,#1f2732 0,#131922 100%);display:none;z-index:18;color:#fff}#cui-phone-root .call-screen.active{display:flex;align-items:center;justify-content:center;padding:20px}#cui-phone-root .call-shell{width:100%;height:100%;display:grid;grid-template-rows:1fr auto}#cui-phone-root .call-top{display:grid;justify-items:center;align-content:center;text-align:center;padding:10px 20px 0}#cui-phone-root .call-avatar{width:112px;height:112px;border-radius:36px;background:#55cbc0;color:#fff;display:grid;place-items:center;font-size:1.6rem;font-weight:800;overflow:hidden;box-shadow:0 18px 36px rgba(0,0,0,.28)}#cui-phone-root .call-name{margin-top:16px;font-size:1.28rem;font-weight:800}#cui-phone-root .call-state{margin-top:8px;font-size:.86rem;color:rgba(255,255,255,.74)}#cui-phone-root .call-dots{display:flex;gap:8px;margin-top:12px}#cui-phone-root .call-dots span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.24)}#cui-phone-root .call-dots span.active{background:#ffe100}#cui-phone-root .call-note{margin-top:16px;font-size:.78rem;line-height:1.6;color:rgba(255,255,255,.7);max-width:240px}#cui-phone-root .call-actions{padding:0 10px 18px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}#cui-phone-root .call-action{display:grid;justify-items:center;gap:8px;color:rgba(255,255,255,.92);cursor:pointer}#cui-phone-root .call-action .circle{width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.1);display:grid;place-items:center;font-size:1rem;font-weight:800}#cui-phone-root .call-action.end .circle{background:#ff5b5b}#cui-phone-root .call-action.active .circle{background:rgba(250,225,0,.28)}#cui-phone-root .call-action span{font-size:.72rem;color:rgba(255,255,255,.76)}\n\n    #cui-phone-root .composer{position:absolute;inset:88px 0 58px;background:rgba(248,250,252,.98);backdrop-filter:blur(18px);z-index:20;display:none;overflow:auto}#cui-phone-root .composer.active{display:block}#cui-phone-root .composer-wrap{padding:16px 14px 22px;display:grid;gap:12px}#cui-phone-root .composer-title{font-size:.92rem;font-weight:800}#cui-phone-root .composer-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px}#cui-phone-root .composer-tab{height:34px;border:none;border-radius:17px;background:#eef2f7;color:#475569;font-size:.8rem;font-weight:800;cursor:pointer}#cui-phone-root .composer-tab.active{background:#111827;color:#fff}#cui-phone-root .composer-note{font-size:.76rem;color:#64748b;line-height:1.55}#cui-phone-root .hidden{display:none!important}\n\n/* ===== Sticker bubble (rendered from <bqb>...</bqb>) ===== */\n#cui-phone-root .sticker-bubble{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:96px;padding:10px 12px;background:rgba(255,221,51,.18);border:1px dashed rgba(255,193,7,.45);border-radius:14px}\n#cui-phone-root .sticker-bubble .sticker-emoji{font-size:1.6rem;line-height:1}\n#cui-phone-root .sticker-bubble .sticker-desc{font-size:.78rem;color:#475569;text-align:center;line-height:1.25;max-width:140px}\n\n#cui-phone-root .sticker-bubble.has-image{padding:4px;background:transparent;border:none;min-width:0}\n#cui-phone-root .sticker-img{display:block;max-width:140px;max-height:140px;width:auto;height:auto;border-radius:12px;object-fit:contain;background:#fff8e1}\n#cui-phone-root .sticker-fallback{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 12px;background:rgba(255,221,51,.18);border:1px dashed rgba(255,193,7,.45);border-radius:14px;min-width:96px}\n";
    document.head.appendChild(styleEl);
}

/** Build the floating root skeleton.
 *  v2 layout: no outer panel/handle. Just FAB + a transparent shell that hosts
 *  the phone UI directly, plus a tiny floating close button.
 */
function buildRoot() {
    if (document.getElementById('cui-phone-root')) {
        return document.getElementById('cui-phone-root');
    }
    const root = document.createElement('div');
    root.id = 'cui-phone-root';
    root.className = 'cui-phone-root cui-collapsed';
    // Inline fallback styles so the FAB is always visible even if style.css
    // didn't load (e.g. cache miss, manifest css line ignored, etc.).
    root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483600;pointer-events:none;';
    root.innerHTML = `
        <button class="cui-phone-fab" id="cui-phone-fab" title="Phone (右键重置位置)"
            style="position:fixed;right:16px;bottom:16px;width:40px;height:40px;border-radius:50%;border:none;background:linear-gradient(135deg,#0a84ff,#6228d7);color:#fff;font-size:18px;cursor:grab;box-shadow:0 8px 22px rgba(15,23,42,.32);display:grid;place-items:center;z-index:2147483601;pointer-events:auto;touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none;opacity:.92;">📱</button>
        <div class="cui-phone-shell">
            <button class="cui-phone-close" id="cui-phone-close" title="Close">✕</button>
            <div class="cui-phone-mount" id="cui-phone-mount"></div>
        </div>
    `;
    document.body.appendChild(root);
    return root;
}

/** Try to register a /phone slash command across multiple ST API versions.
 *  This is best-effort; failure is silent so the main feature still works.
 *  NOTE: slash command API has shifted over ST versions — this needs to be
 *  verified against your installed version.
 */
function registerPhoneCommand(toggle) {
    try {
        const ctx = window.TavernHelper || {};
        // Newer API (SlashCommand / SlashCommandParser)
        if (ctx.SlashCommandParser && ctx.SlashCommand) {
            const cmd = ctx.SlashCommand.fromProps({
                name: 'phone',
                callback: () => { toggle(); return ''; },
                helpString: 'Toggle the CUI Phone panel.',
            });
            ctx.SlashCommandParser.addCommandObject(cmd);
            console.log('[CUI Phone] /phone slash command registered (new API).');
            return;
        }
        // Legacy API
        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('phone', () => { toggle(); return ''; }, [],
                'Toggle the CUI Phone panel.', true, true);
            console.log('[CUI Phone] /phone slash command registered (legacy API).');
            return;
        }
        console.warn('[CUI Phone] No known slash command API found; skipping.');
    } catch (e) {
        console.warn('[CUI Phone] Slash command registration failed:', e);
    }
}

/** Persistent extension settings (global preferences). */
function getSettings() {
    return window.__cuiPhoneTHSettings || (window.__cuiPhoneTHSettings = { startCollapsed: true });
}

// Re-entry guard. ST's extension system can call this module twice (e.g.
// after a reload). Without this we'd double-bind every listener and
// accumulate setInterval timers, which makes the FAB jitter and burns CPU.
if (window.__cuiPhoneBooted) {
    console.log('[CUI Phone] already booted; skipping re-init.');
} else {
    window.__cuiPhoneBooted = true;
}

(async function init() {
    // Inject outer wrapper styles (FAB, shell, drag visuals, etc.)
    if (!document.getElementById('cui-phone-outer-css')) {
        const outerStyle = document.createElement('style');
        outerStyle.id = 'cui-phone-outer-css';
        outerStyle.textContent = "/* =====================================================================\n * CUI Phone — outer container styles\n * v4: Draggable FAB. Phone-shell pops out anchored to the FAB position.\n * The FAB is hidden while the phone is open; clicking ✕ restores it.\n * ===================================================================== */\n\n#cui-phone-root {\n    position: fixed;\n    /* JS sets left/top at runtime. Initial fallback = right-bottom corner. */\n    right: 16px;\n    bottom: 16px;\n    bottom: calc(16px + env(safe-area-inset-bottom, 0px));\n    /* Pushed very high so ST modals / mobile overlays don't bury the FAB. */\n    z-index: 2147483600;\n    width: 0;          /* root is just a positioning anchor; children are fixed */\n    height: 0;\n    font-family: Inter, system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n    pointer-events: none;   /* root itself is non-interactive; children re-enable */\n}\n\n/* ---- Floating action button — DRAGGABLE ---- */\n#cui-phone-root .cui-phone-fab {\n    position: fixed;\n    /* JS sets left/top at runtime. Initial fallback hugs root's anchor. */\n    right: 16px;\n    bottom: 16px;\n    bottom: calc(16px + env(safe-area-inset-bottom, 0px));\n    width: 40px;\n    height: 40px;\n    border-radius: 50%;\n    border: none;\n    background: linear-gradient(135deg, #0a84ff, #6228d7);\n    color: #fff;\n    font-size: 18px;\n    opacity: 0.92;\n    cursor: grab;\n    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35);\n    display: grid;\n    place-items: center;\n    /* Sit above any ST chrome — mobile menu, sidebar, modals all top out lower. */\n    z-index: 2147483601;\n    pointer-events: auto;\n    -webkit-tap-highlight-color: transparent;\n    touch-action: none;        /* let JS handle drag without browser scrolling */\n    user-select: none;\n}\n#cui-phone-root .cui-phone-fab:active { cursor: grabbing; }\n#cui-phone-root .cui-phone-fab.dragging { transform: scale(1.08); }\n\n/* When phone is open, hide the FAB so phone takes the same anchor slot. */\n#cui-phone-root:not(.cui-collapsed) .cui-phone-fab { display: none; }\n\n/* ---- Phone container ----\n * JS positions this via inline left/top anchored to the FAB's last position.\n * Native size is 390x844; --cui-scale (computed from viewport + user pref)\n * scales the wrapper. transform-origin is set by JS based on FAB corner.\n */\n#cui-phone-root .cui-phone-shell {\n    position: fixed;\n    /* JS sets left:0; top:0 plus a transform: translate(...) scale(...)\n     * every time the phone is opened. The transform is the single source of\n     * truth for both position AND scale, so the visual layout is always\n     * inside the viewport, regardless of how short/narrow the window is.\n     */\n    left: 0;\n    top: 0;\n    width: 390px;\n    height: 844px;\n    background: transparent;\n    pointer-events: auto;\n    z-index: 2147483600;\n    transform-origin: 0 0;\n}\n#cui-phone-root.cui-collapsed .cui-phone-shell { display: none; }\n\n#cui-phone-root .cui-phone-mount {\n    width: 100%;\n    height: 100%;\n    position: relative;\n}\n\n/* ---- Close button on the phone ---- */\n#cui-phone-root .cui-phone-close {\n    position: absolute;\n    top: 6px;\n    right: 6px;\n    width: 32px;\n    height: 32px;\n    border-radius: 50%;\n    border: none;\n    background: rgba(15, 23, 42, 0.92);\n    color: #fff;\n    font-size: 16px;\n    line-height: 1;\n    cursor: pointer;\n    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.45);\n    z-index: 5;\n    display: grid;\n    place-items: center;\n    -webkit-tap-highlight-color: transparent;\n    touch-action: manipulation;\n}\n#cui-phone-root .cui-phone-close:hover { background: #0f172a; }\n\n/* ---- iOS auto-zoom guard ---- */\n#cui-phone-root input,\n#cui-phone-root textarea,\n#cui-phone-root select {\n    font-size: 16px;\n}\n\n@media (pointer: coarse) {\n    #cui-phone-root button,\n    #cui-phone-root .tool-btn,\n    #cui-phone-root .ins-tab,\n    #cui-phone-root .composer-tab {\n        min-height: 36px;\n    }\n}\n";
        document.head.appendChild(outerStyle);
    }
    if (window.__cuiPhoneInitDone) return;
    // Wait for SillyTavern global to be available
    if (typeof window.TavernHelper === 'undefined') {
        console.warn('[CUI Phone TH] TavernHelper not detected; aborting.');
        return;
    }

    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    await injectInnerCss();
    const root = buildRoot();
    window.__cuiPhoneInitDone = true;

    // Load HTML fragment (inlined at build time)
    const html = "  <section class=\"phone-shell\">\n    <div class=\"dynamic-island\"></div>\n    <div class=\"screen\">\n      <div class=\"wallpaper\"></div>\n      <div class=\"statusbar\"><span id=\"statusTime\"></span><div class=\"status-right\"><span>LTE</span><span id=\"statusBatteryPct\">87%</span><div class=\"battery\" id=\"statusBattery\"><div class=\"battery-fill\" id=\"statusBatteryFill\"></div></div></div></div>\n\n      <section class=\"view lock-view active\" data-view=\"lock\">\n        <div class=\"lock-top\"><div class=\"lock-date\" id=\"lockDate\"></div><div class=\"lock-time\" id=\"lockTime\"></div></div>\n        <div class=\"notif-stack\" id=\"lockNotifStack\"></div>\n        <div class=\"unlock-hint\">点击任意位置解锁</div>\n      </section>\n\n      <section class=\"view home-view\" data-view=\"home\">\n        <div class=\"home-layout\">\n          <div>\n            <div class=\"home-head\">\n              <div><div class=\"home-title\">Cui Phone</div></div>\n              <div style=\"font-size:.76rem;color:rgba(255,255,255,.82)\">第 1 页</div>\n            </div>\n            <div class=\"icon-grid\">\n              <div class=\"app-slot\"><button class=\"app-button\" data-open-app=\"ins\"><div class=\"icon-tile ins\"></div><div class=\"icon-label\">Instagram</div></button></div>\n              <div class=\"app-slot\"><button class=\"app-button\" data-open-app=\"kkt\"><div class=\"icon-tile kkt\">K</div><div class=\"icon-label\">KakaoTalk</div></button></div>\n              <div class=\"app-slot\"><button class=\"app-button\" data-open-app=\"st\"><div class=\"icon-tile memo\">ST</div><div class=\"icon-label\">导入</div></button></div>\n            </div>\n          </div>\n          <div class=\"dock\">\n            <button class=\"app-button\" data-open-app=\"kkt\"><div class=\"icon-tile kkt\">K</div></button>\n            <button class=\"app-button\" data-open-app=\"ins\"><div class=\"icon-tile ins\"></div></button>\n            <button class=\"app-button\" data-open-app=\"st\"><div class=\"icon-tile memo\">ST</div></button>\n            <button class=\"app-button\"><div class=\"icon-tile memo\"></div></button>\n          </div>\n        </div>\n      </section>\n\n      <section class=\"view app-view\" data-view=\"ins\">\n        <header class=\"app-topbar\">\n          <div class=\"app-left\"><button class=\"nav-btn\" data-home>‹</button><div><div class=\"app-title\">Instagram</div><div class=\"app-subline\" id=\"insSubline\">Following feed</div></div></div>\n          <div class=\"app-right\"><button class=\"icon-circle\" id=\"openComposerBtn\">＋</button></div>\n        </header>\n        <section class=\"panel active\" data-ins-panel=\"feed\">\n          <div class=\"stories-row\" id=\"storiesRow\"></div>\n          <div class=\"feed-list\" id=\"feedList\"></div>\n        </section>\n        <section class=\"panel story-panel\" data-ins-panel=\"story\">\n          <div class=\"story-view\">\n            <div class=\"story-progress-wrap\" id=\"storyProgress\"></div>\n            <div class=\"story-head\">\n              <div class=\"story-user\"><div class=\"story-ring\"><div class=\"avatar-core\" id=\"storyAvatar\"></div></div><div><div class=\"story-name\" id=\"storyHandle\"></div><div class=\"story-time\" id=\"storyMeta\"></div></div></div>\n              <div style=\"font-size:.78rem;color:rgba(255,255,255,.76)\">轻点右侧或左滑切换</div>\n            </div>\n            <div class=\"story-canvas\" id=\"storyCanvas\"><div class=\"story-chips\" id=\"storyChips\"></div></div>\n            <div class=\"story-reply\"><input id=\"storyReplyInput\" placeholder=\"回复这条 Story\" /><button class=\"icon-circle\" id=\"storyLikeBtn\">♡</button><button class=\"story-send\" id=\"storySendBtn\">发送</button></div>\n          </div>\n        </section>\n        <section class=\"panel profile-panel\" data-ins-panel=\"profile\">\n          <div class=\"profile-header\">\n            <div class=\"profile-main\">\n              <div class=\"profile-avatar\"><div class=\"avatar-core\" id=\"userAvatarMain\">ME</div></div>\n              <div>\n                <div style=\"font-size:1rem;font-weight:800\" id=\"userHandleText\">@my.archive</div>\n                <div class=\"profile-stats\">\n                  <div><div class=\"stat-num\" id=\"userPostsCount\">9</div><div class=\"stat-label\">帖子</div></div>\n                  <div><div class=\"stat-num\" id=\"userFollowersCount\">312</div><div class=\"stat-label\">粉丝</div></div>\n                  <div><div class=\"stat-num\" id=\"userFollowingCount\">187</div><div class=\"stat-label\">关注</div></div>\n                </div>\n              </div>\n            </div>\n            <div class=\"profile-bio\"><div style=\"font-weight:800\" id=\"userNameText\">你的名字</div><div id=\"userBioText\">这是用户主页，可自定义。角色动态在 Feed 里看。</div><div class=\"profile-link\" id=\"userLinkText\">your-link.example</div></div>\n          </div>\n          <div class=\"highlight-row\" id=\"highlightRow\"></div>\n          <div class=\"profile-tools\"><div class=\"tool-row\"><button class=\"tool-btn primary\" id=\"openProfileEditBtn\">编辑主页</button><button class=\"tool-btn secondary\" id=\"openImportBtn\">导入 ST 文本</button></div></div>\n          <div class=\"editor-box collapsed\" id=\"avatarEditor\">\n            <div class=\"editor-title\">头像更换</div>\n            <div class=\"avatar-preview-row\">\n              <div class=\"avatar-card\"><div class=\"tiny-label\">你的头像</div><div class=\"avatar-core\" id=\"userAvatarPreview\">ME</div></div>\n              <div class=\"avatar-card\"><div class=\"tiny-label\">角色头像</div><div class=\"avatar-core\" id=\"characterAvatarPreview\">CZ</div></div>\n            </div>\n            <div class=\"avatar-grid\"><input class=\"text-input\" id=\"userAvatarInput\" placeholder=\"你的头像 URL\" /><input class=\"text-input\" id=\"characterAvatarInput\" placeholder=\"主角色头像 URL\" /></div>\n            <textarea class=\"text-area\" id=\"avatarMapInput\" placeholder=\"@jungsoo_23=https://...&#10;@byeongchan_21=https://...\"></textarea>\n            <div class=\"tool-row\"><button class=\"tool-btn secondary\" id=\"applyAvatarBtn\">应用头像</button><span class=\"save-hint\" id=\"avatarHint\">修改后会同步到 Story、Feed、主页与 KKT。</span></div>\n          </div>\n          <div class=\"editor-box collapsed\" id=\"profileEditor\">\n            <div class=\"editor-title\">自定义主页</div>\n            <input class=\"text-input\" id=\"editHandle\" placeholder=\"my.archive\" />\n            <input class=\"text-input\" id=\"editName\" placeholder=\"你的名字\" />\n            <input class=\"text-input\" id=\"editBio\" placeholder=\"简介\" />\n            <input class=\"text-input\" id=\"editLink\" placeholder=\"链接\" />\n            <input class=\"text-input\" id=\"editHighlights\" placeholder=\"高光，逗号分隔\" />\n            <textarea class=\"text-area\" id=\"editGridCaptions\" placeholder=\"九宫格文案，逗号分隔\"></textarea>\n            <div class=\"tool-row\"><button class=\"tool-btn secondary\" id=\"resetProfileBtn\">重置资料</button><button class=\"tool-btn secondary\" id=\"cancelProfileEditBtn\">取消</button><button class=\"tool-btn primary\" id=\"saveProfileBtn\">保存主页</button></div>\n            <div class=\"save-hint\">资料会存在本机浏览器，跨角色共享；重置后下次刷新会从世界书重读。</div>\n          </div>\n          <div class=\"profile-grid-head\"><span>帖子</span><span style=\"color:#94a3b8;font-weight:600\">3 × 3</span></div>\n          <div class=\"profile-grid\" id=\"profileGrid\"></div>\n        </section>\n        <section class=\"composer\" id=\"composerPanel\">\n          <div class=\"composer-wrap\">\n            <div class=\"composer-title\">发布你的 Instagram 内容</div>\n            <div class=\"composer-tabs\"><button class=\"composer-tab active\" data-compose=\"feed\">发 Feed</button><button class=\"composer-tab\" data-compose=\"story\">发 Story</button></div>\n            <input class=\"text-input\" id=\"composerMeta\" placeholder=\"Feed：18:42 Busan / Story：23:41\" />\n            <input class=\"text-input\" id=\"composerMedia\" placeholder=\"图片描述 / 音乐 / 贴纸说明\" />\n            <input class=\"text-input\" id=\"composerMediaUrl\" placeholder=\"图片 URL，可直接贴 ST 输出链接\" />\n            <input class=\"text-input\" id=\"composerLikes\" placeholder=\"Feed 点赞数，如 1,245\" />\n            <textarea class=\"text-area\" id=\"composerText\" placeholder=\"正文内容\"></textarea>\n            <textarea class=\"text-area\" id=\"composerComments\" placeholder=\"Feed 评论，每行一条\"></textarea>\n\n            <div class=\"tool-row\"><button class=\"tool-btn secondary\" id=\"closeComposerBtn\">关闭</button><button class=\"tool-btn primary\" id=\"publishComposerBtn\">发布</button></div>\n          </div>\n        </section>\n        <div class=\"ins-tabs\"><button class=\"ins-tab active\" data-ins-tab=\"feed\">首页</button><button class=\"ins-tab\" data-ins-tab=\"story\">Story</button><button class=\"ins-tab\" data-ins-tab=\"profile\">我的</button></div>\n      </section>\n\n      <section class=\"view app-view\" data-view=\"kkt\">\n        <header class=\"app-topbar\">\n          <div class=\"app-left\"><button class=\"nav-btn\" data-home>‹</button><div><div class=\"app-title\">KakaoTalk</div><div class=\"app-subline\" id=\"kktSubline\">Chats</div></div></div>\n          <div class=\"app-right\"><button class=\"icon-circle\" id=\"openImportBtnTop\">ST</button></div>\n        </header>\n        <section class=\"panel active\" data-kkt-panel=\"list\"><div class=\"kkt-list\" id=\"chatList\"></div></section>\n        <section class=\"panel\" data-kkt-panel=\"chat\">\n          <div class=\"kkt-chat\">\n            <div class=\"kkt-hero\"><div class=\"kkt-hero-avatar avatar-core\" id=\"roomAvatar\">KT</div><div><div class=\"kkt-hero-name\" id=\"roomName\">KakaoTalk</div><div class=\"kkt-hero-sub\" id=\"roomSub\">单聊</div></div><button class=\"kkt-hero-btn\" id=\"editRoomBtn\">✎</button><button class=\"kkt-hero-btn\" id=\"callRoomBtn\">☎</button></div>\n            <div class=\"thread\" id=\"thread\"></div>\n            <div class=\"inputbar\"><button class=\"plus-btn\" id=\"openEmojiSheetBtn\">＋</button><div class=\"input-shell\"><input id=\"kktInput\" placeholder=\"输入消息\" /></div><button class=\"send-btn\" id=\"sendKktBtn\">发送</button></div>\n          </div>\n        </section>\n        <section class=\"sheet collapsed\" id=\"roomEditorSheet\">\n          <div class=\"sheet-handle\"></div>\n          <div class=\"sheet-card\">\n            <div class=\"sheet-title\">修改当前聊天室</div>\n            <div class=\"sheet-sub\">这里只改当前 KKT 房间名称与头像，不影响 INS 主页。也可以继续用 ST 批量导入消息。</div>\n            <div class=\"sheet-row\"><input class=\"sheet-input\" id=\"roomNameInput\" placeholder=\"聊天室名称\" /><input class=\"sheet-input\" id=\"roomAvatarInput\" placeholder=\"头像 URL，可留空\" /></div>\n            <div class=\"sheet-actions\"><button class=\"tool-btn secondary\" id=\"cancelRoomEditBtn\">取消</button><button class=\"tool-btn primary\" id=\"saveRoomEditBtn\">保存</button></div>\n          </div>\n        </section>\n        <section class=\"sheet collapsed\" id=\"emojiSheet\">\n          <div class=\"sheet-handle\"></div>\n          <div class=\"sheet-card\">\n            <div class=\"sheet-title\">表情与贴纸</div>\n            <div class=\"sheet-sub\">这里改成 KKT 聊天附加功能，不再和 ST 导入重复。</div>\n            <div class=\"emoji-sheet\">\n              <button class=\"emoji-btn\">🙂</button><button class=\"emoji-btn\">🥺</button><button class=\"emoji-btn\">😶</button><button class=\"emoji-btn\">😑</button><button class=\"emoji-btn\">😭</button><button class=\"emoji-btn\">❤️</button>\n            </div>\n            <div class=\"sticker-list\">\n              <button class=\"sticker-btn\">已读。\n(贴纸)</button>\n              <button class=\"sticker-btn\">现在回。\n(贴纸)</button>\n              <button class=\"sticker-btn\">忙完说。\n(贴纸)</button>\n              <button class=\"sticker-btn\">收到。\n(贴纸)</button>\n            </div>\n            <div class=\"tool-row\"><button class=\"tool-btn secondary\" id=\"closeEmojiSheetBtn\">关闭</button></div>\n          </div>\n        </section>\n        <section class=\"call-screen\" id=\"callScreen\">\n          <div class=\"call-shell\">\n            <div class=\"call-top\"><div class=\"call-avatar avatar-core\" id=\"callAvatar\">KT</div><div class=\"call-name\" id=\"callName\">崔宗秀</div><div class=\"call-state\" id=\"callState\">连接中</div><div class=\"call-dots\"><span class=\"active\"></span><span></span><span></span></div></div>\n            <div class=\"call-actions\"><div class=\"call-action\" id=\"muteCallBtn\"><div class=\"circle\">麦</div><span>静音</span></div><div class=\"call-action\" id=\"speakerCallBtn\"><div class=\"circle\">扬</div><span>扬声器</span></div><div class=\"call-action end\" id=\"endCallBtn\"><div class=\"circle\">断</div><span>挂断</span></div><div class=\"call-action\" id=\"backCallBtn\"><div class=\"circle\">返</div><span>返回聊天</span></div></div>\n          </div>\n        </section>\n      </section>\n\n      <section class=\"view app-view\" data-view=\"st\">\n        <header class=\"app-topbar\">\n          <div class=\"app-left\"><button class=\"nav-btn\" data-home>‹</button><div><div class=\"app-title\">导入</div><div class=\"app-subline\">手动贴一段世界书/正文调试用</div></div></div>\n          <div class=\"app-right\"><button class=\"icon-circle\" id=\"applyImportBtnTop\">✓</button></div>\n        </header>\n        <section class=\"panel active\" style=\"bottom:0;padding:16px;background:#fff;display:block\">\n          <div class=\"editor-box\" style=\"border:none;padding:0;background:transparent\">\n            <div class=\"editor-title\">导入说明</div>\n            <div style=\"font-size:.8rem;line-height:1.7;color:#64748b\">可把 SillyTavern 变量替换后的文本直接粘贴进来，点击应用后会本地解析到 INS Story、INS Feed、KKT 聊天和角色主页。支持你继续在角色卡 / 世界书里拼接这些块。</div>\n            <textarea class=\"text-area\" id=\"stImportText\" style=\"min-height:250px\" placeholder=\"支持标签：<user_profile> <ins_profiles> <sticker_base> <ins_story> <ins_feed> <kakao_chat>&#10;正常用法：ST 会自动从聊天记录里提取，这里只是手动调试用。\"></textarea>\n            <div class=\"tool-row\"><button class=\"tool-btn secondary\" id=\"resetImportBtn\">恢复默认</button><button class=\"tool-btn primary\" id=\"applyImportBtn\">应用导入</button></div>\n            <div class=\"editor-title\">世界书可识别的标签</div>\n            <textarea class=\"text-area\" readonly style=\"min-height:300px\">&lt;sticker_base&gt;\nhttps://files.catbox.moe/\n&lt;/sticker_base&gt;\n\n&lt;ins_profiles&gt;\n@handle1=https://files.catbox.moe/xxxxxx.jpg\n@handle2=https://files.catbox.moe/yyyyyy.jpg\n&lt;/ins_profiles&gt;\n\n&lt;ins_story&gt;\n@handle1 · 名字 | HH:MM 氛围\n[图 · 描述]\n[音乐 · 曲名]\nstory 字幕：...\n&lt;/ins_story&gt;\n\n&lt;ins_feed&gt;\n@handle1 · 名字 | 18:42 Busan\n[图 · 描述]\n❤️ 2,105\n正文/caption\n@评论者：评论\n&lt;/ins_feed&gt;\n\n&lt;kakao_chat&gt;\n[群] 群名        （可选，有 = 群聊，无 = 单聊）\n⚫ 最终数 | 22:12\nᄀ 正文\nᄀ &lt;bqb&gt;晚安 5brt1b.jpeg&lt;/bqb&gt;\n🟡 用户 | 22:13\nᄀ 正文\n&lt;/kakao_chat&gt;</textarea>\n          </div>\n        </section>\n      </section>\n\n      <div class=\"home-indicator\"></div>\n    </div>\n  </section>\n";

    const mount = root.querySelector('#cui-phone-mount');
    mount.innerHTML = html;

    // Boot the original phone UI script. If this throws, the phone HTML is
    // visible but inert — surface it so the user knows to open DevTools.
    let phoneBootOk = true;
    try {
        window.__cuiPhoneMount(mount);
    } catch (e) {
        phoneBootOk = false;
        console.error('[CUI Phone] window.__cuiPhoneMount failed:', e);
        const banner = document.createElement('div');
        banner.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;padding:8px 10px;border-radius:8px;background:#dc2626;color:#fff;font:13px system-ui;z-index:99;line-height:1.4';
        banner.textContent = '手机 UI 加载失败：' + (e && e.message || e) + '。请打开控制台查看堆栈。';
        mount.appendChild(banner);
    }

    // ---- FAB drag + open-near-FAB positioning ----
    const FAB_POS_KEY = 'cuiphone:fab_pos';
    const fab = root.querySelector('#cui-phone-fab');
    const shell = root.querySelector('.cui-phone-shell');

    function loadFabPos() {
        try {
            const p = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
            if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
        } catch (_) {}
        return null;
    }
    function saveFabPos(left, top) {
        try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left, top })); } catch (_) {}
    }
    function clampFabPos(p) {
        // Keep at least the FAB visible inside the viewport.
        const fw = fab.offsetWidth || 40;
        const fh = fab.offsetHeight || 40;
        const left = Math.max(0, Math.min(window.innerWidth - fw, p.left));
        const top = Math.max(0, Math.min(window.innerHeight - fh, p.top));
        return { left, top };
    }
    function applyFabPos(p) {
        if (!p) return;
        fab.style.left = p.left + 'px';
        fab.style.top = p.top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }
    function positionPhoneNearFab() {
        // CRITICAL: phone-shell is a 390x844 box that we visually shrink with
        // `transform: scale(s)`. transform doesn't change the layout box — so
        // we use top:0; left:0; and then `transform: translate(X,Y) scale(s)`
        // with `transform-origin: 0 0` to position the SCALED visual exactly
        // where we want it. Anything else makes the phone fly off-screen on
        // small viewports (split-screen, narrow windows).
        const r = fab.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;

        // What's the actual scale the CSS will apply right now?
        const cs = parseFloat(getComputedStyle(root).getPropertyValue('--cui-scale')) || 1;
        const scaledW = PHONE_W * cs;
        const scaledH = PHONE_H * cs;

        const fabCx = r.left + r.width / 2;
        const fabCy = r.top + r.height / 2;
        const onRight = fabCx > vw / 2;
        const onBottom = fabCy > vh / 2;

        // Decide where the SCALED phone's top-left corner should land so its
        // visible body covers the FAB position with no gap, but stays inside
        // the viewport with at least an 8px margin.
        let tx, ty;
        if (onRight) {
            // anchor right edge of phone at FAB's right edge
            tx = r.right - scaledW;
        } else {
            tx = r.left;
        }
        if (onBottom) {
            ty = r.bottom - scaledH;
        } else {
            ty = r.top;
        }
        // Clamp into viewport with 8px safety margin so the phone never
        // disappears off-screen on narrow / short windows.
        tx = Math.max(8, Math.min(vw - scaledW - 8, tx));
        ty = Math.max(8, Math.min(vh - scaledH - 8, ty));
        // If the phone is bigger than the viewport (shouldn't happen given
        // recomputeScale's cap, but be defensive), pin to top-left.
        if (scaledW > vw - 16) tx = 8;
        if (scaledH > vh - 16) ty = 8;

        shell.style.left = '0px';
        shell.style.top = '0px';
        shell.style.right = 'auto';
        shell.style.bottom = 'auto';
        shell.style.transformOrigin = '0 0';
        shell.style.transform = `translate(${tx}px, ${ty}px) scale(${cs})`;
    }

    // Restore stored FAB position (if any) on startup.
    const savedFab = loadFabPos();
    if (savedFab) applyFabPos(clampFabPos(savedFab));

    // Pointer-based drag (works for mouse + touch + pen).
    let dragging = false, didMove = false, sx = 0, sy = 0, ox = 0, oy = 0;
    fab.addEventListener('pointerdown', (e) => {
        // Left mouse button only; touch/pen always pass.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = true;
        didMove = false;
        const rect = fab.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY;
        ox = rect.left; oy = rect.top;
        try { fab.setPointerCapture(e.pointerId); } catch (_) {}
        fab.classList.add('dragging');
    });
    fab.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        // 6px threshold (was 4): higher = fewer accidental drags from finger tremor.
        if (!didMove && (Math.abs(dx) + Math.abs(dy) > 6)) didMove = true;
        if (!didMove) return;
        const fw = fab.offsetWidth || 40;
        const fh = fab.offsetHeight || 40;
        const nx = Math.max(0, Math.min(window.innerWidth - fw, ox + dx));
        const ny = Math.max(0, Math.min(window.innerHeight - fh, oy + dy));
        fab.style.left = nx + 'px';
        fab.style.top = ny + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    });
    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        fab.classList.remove('dragging');
        const wasDrag = didMove;
        if (didMove) {
            const rect = fab.getBoundingClientRect();
            saveFabPos(rect.left, rect.top);
        }
        try { if (e && e.pointerId != null) fab.releasePointerCapture(e.pointerId); } catch (_) {}
        // Reset didMove on the next tick so the click event that follows
        // pointerup can still see it (to suppress a toggle if the user dragged).
        // Then it MUST go back to false so the very next click works.
        if (wasDrag) {
            setTimeout(() => { didMove = false; }, 0);
        } else {
            didMove = false;
        }
    }
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);

    // Right-click FAB → reset its position to bottom-right (escape hatch).
    fab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        fab.style.left = 'auto';
        fab.style.top = 'auto';
        fab.style.right = '16px';
        fab.style.bottom = '16px';
        try { localStorage.removeItem(FAB_POS_KEY); } catch(_){}
    });

    // Esc → close phone (works even if close button is off-screen).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !root.classList.contains('cui-collapsed')) {
            root.classList.add('cui-collapsed');
        }
    });

    // Open / close. Hoist root to body tail just before showing the phone
    // so we always start out on top, regardless of what ST inserted.
    const toggle = () => {
        if (root.classList.contains('cui-collapsed')) {
            hoistIfNeeded();
            positionPhoneNearFab();
            root.classList.remove('cui-collapsed');
        } else {
            root.classList.add('cui-collapsed');
        }
    };
    fab.addEventListener('click', (e) => {
        // If this click is the natural follow-up to a drag, swallow it once.
        if (didMove) {
            e.preventDefault();
            e.stopPropagation();
            didMove = false;
            return;
        }
        toggle();
    });

    // ---- HARD FALLBACK: window-level capture-phase click handler ----
    // ST in mobile/split-screen mode (≤1000px) makes #sheld and various
    // drawers 100dvw with high z-index. These can sit on top of the FAB and
    // intercept its click events even though the FAB is visible. Listening
    // on `window` at the capture phase fires BEFORE any host handler, and
    // hit-testing by coordinates lets us detect a click "through" any layer.
    function pointHitsFab(x, y) {
        const r = fab.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    function pointHitsCloseBtn(x, y) {
        const close = root.querySelector('#cui-phone-close');
        if (!close || root.classList.contains('cui-collapsed')) return false;
        const r = close.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    let _winDownX = 0, _winDownY = 0, _winDownOnFab = false;
    window.addEventListener('pointerdown', (e) => {
        _winDownX = e.clientX; _winDownY = e.clientY;
        _winDownOnFab = pointHitsFab(e.clientX, e.clientY);
    }, { capture: true });
    window.addEventListener('pointerup', (e) => {
        const dx = e.clientX - _winDownX, dy = e.clientY - _winDownY;
        const moved = Math.abs(dx) + Math.abs(dy) > 6;
        // Close button takes priority when phone is open.
        if (!moved && pointHitsCloseBtn(e.clientX, e.clientY)) {
            e.preventDefault(); e.stopPropagation();
            root.classList.add('cui-collapsed');
            return;
        }
        if (!_winDownOnFab) return;
        if (moved) return;  // drag handled by FAB's own listeners
        if (!pointHitsFab(e.clientX, e.clientY)) return;
        // We have a clean click on the FAB at the window-capture level.
        // If the FAB's own click would also fire, double-toggle would result.
        // Solve by deferring + checking if state still needs change.
        const wasCollapsed = root.classList.contains('cui-collapsed');
        setTimeout(() => {
            const isCollapsed = root.classList.contains('cui-collapsed');
            if (wasCollapsed === isCollapsed) {
                // FAB's click never landed — force the toggle now.
                console.warn('[CUI Phone] FAB click was blocked by host; toggling via window fallback');
                toggle();
            }
        }, 50);
    }, { capture: true });

    // Hoist root to body tail when needed. Two triggers:
    //   (a) MutationObserver: any time something is appended to body
    //   (b) Right before the user opens the phone (in toggle())
    // This is cheaper than a 2s polling timer and reacts immediately when
    // ST/another extension inserts a sibling above us.
    function hoistIfNeeded() {
        if (document.body && document.body.lastElementChild !== root) {
            document.body.appendChild(root);
        }
    }
    try {
        const mo = new MutationObserver(() => hoistIfNeeded());
        mo.observe(document.body, { childList: true });
    } catch (_) {
        // Fall back to a low-frequency timer only if MO is unavailable.
        setInterval(hoistIfNeeded, 5000);
    }
    root.querySelector('#cui-phone-close').onclick = () => root.classList.add('cui-collapsed');

    // Re-clamp FAB on viewport resize so it never escapes off-screen,
    // and recompute auto-fit scale, and reposition phone if open.
    window.addEventListener('resize', () => {
        const cur = loadFabPos();
        if (cur) {
            const c = clampFabPos(cur);
            applyFabPos(c);
            // Persist the clamped position so next time we open we use the visible spot.
            saveFabPos(c.left, c.top);
        }
        // recomputeScale is defined below — guard with typeof to be safe.
        if (typeof recomputeScale === 'function') recomputeScale();
        if (!root.classList.contains('cui-collapsed')) positionPhoneNearFab();
    });

    if (!settings.startCollapsed) {
        positionPhoneNearFab();
        root.classList.remove('cui-collapsed');
    }

    // ---- Auto-fit + user-adjustable scale ----
    // Native phone-shell size is 390 x 844. We must fit it inside
    //   width-budget = innerWidth - 32   (margins)
    //   height-budget = innerHeight - 96  (FAB + margins)
    // and then multiply by the user's preferred scale (default 1, range 0.5..1.6).
    const PHONE_W = 390, PHONE_H = 844;
    const SCALE_KEY = 'cuiphone:user_scale';
    // Default 1.15 = phone visibly larger than v3, text easier to read.
    // Range 0.5..2.0 lets users push past native size on big monitors.
    let userScale = 1.15;
    try {
        const saved = parseFloat(localStorage.getItem(SCALE_KEY) || '');
        if (!isNaN(saved) && saved > 0) userScale = Math.max(0.5, Math.min(2.0, saved));
    } catch(_){}

    function recomputeScale() {
        // Phone is open in place of the FAB now, so the height budget is the
        // entire viewport minus a small safety margin.
        const fitW = (window.innerWidth - 32) / PHONE_W;
        const fitH = (window.innerHeight - 32) / PHONE_H;
        // Allow modest upscaling above native (cap 1.3) so on tall monitors
        // the phone doesn't sit there at 100% looking small.
        const fit = Math.min(1.3, fitW, fitH);
        const final = Math.max(0.4, fit * userScale);
        root.style.setProperty('--cui-scale', final.toFixed(3));
        // CRITICAL: shell's transform is set as a literal string by
        // positionPhoneNearFab (translate + scale baked together). Changing
        // --cui-scale alone won't update it. So if the phone is open, we
        // re-run the positioner so the visible scale tracks Ctrl+wheel live.
        if (!root.classList.contains('cui-collapsed')) {
            positionPhoneNearFab();
        }
    }
    recomputeScale();

    function applyUserScale(s) {
        userScale = Math.max(0.5, Math.min(2.0, s));
        try { localStorage.setItem(SCALE_KEY, String(userScale)); } catch(_){}
        recomputeScale();
    }
    // Ctrl+wheel ⇌ resize. Listener is on `window` (not `root`) because root
    // has pointer-events:none for click pass-through. We accept the event
    // ONLY when the cursor is actually over the FAB or the phone-shell;
    // otherwise let ST do whatever it wants with the wheel.
    window.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        const t = e.target;
        if (!t || !(t instanceof Element)) return;
        // Is the wheel over our UI? Check ancestor chain, plus elementFromPoint
        // since pointer-events:none on root would otherwise hide it from `target`.
        const overOurs = t.closest && (t.closest('#cui-phone-fab') || t.closest('.cui-phone-shell'));
        if (!overOurs) {
            // Fallback: pointer-events:none on root could route the event to ST,
            // so use coordinates to decide if cursor is on top of phone-shell.
            const sr = shell.getBoundingClientRect();
            const fr = fab.getBoundingClientRect();
            const x = e.clientX, y = e.clientY;
            const inShell = !root.classList.contains('cui-collapsed') &&
                x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom;
            const inFab = x >= fr.left && x <= fr.right && y >= fr.top && y <= fr.bottom;
            if (!inShell && !inFab) return;
        }
        e.preventDefault();
        applyUserScale(userScale + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false, capture: true });

    window.CuiPhone = window.CuiPhone || {};
    window.CuiPhone.setScale = applyUserScale;
    window.CuiPhone.getScale = () => userScale;
    window.CuiPhone.recomputeScale = recomputeScale;

    // Wire ST <-> phone (chat sync, send-back, events)
    try {
        window.__cuiPhoneWireBridge(ctx, window.CuiPhone);
    } catch (e) {
        console.error('[CUI Phone] window.__cuiPhoneWireBridge failed:', e);
    }

    // /phone command
    registerPhoneCommand(toggle);

    console.log('[CUI Phone] Loaded. Click the 📱 FAB or run /phone to toggle.');
})();


    })(_parentWin, _parentWin.document, _parentWin.navigator, _parentWin.location);
})();
