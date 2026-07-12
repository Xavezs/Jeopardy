/* =====================================================================
     STORAGE LAYER
     Low-level key/value access with three fallbacks so the app works both
     inside a Claude artifact (window.storage) and as a plain local file
     opened directly in a browser (localStorage), or worst case, in-memory
     only for the current tab session.
     ===================================================================== */
  const MemoryStore = Object.create(null);

  const Store = {
    async get(key){
      try{
        if (window.storage && window.storage.get){
          const r = await window.storage.get(key, false);
          return r ? r.value : null;
        }
      }catch(e){}
      try{
        const v = localStorage.getItem(key);
        if (v !== null) return v;
      }catch(e){}
      return Object.prototype.hasOwnProperty.call(MemoryStore, key) ? MemoryStore[key] : null;
    },
    async set(key, value){
      try{
        if (window.storage && window.storage.set){
          await window.storage.set(key, value, false);
          return true;
        }
      }catch(e){}
      try{
        localStorage.setItem(key, value);
        return true;
      }catch(e){}
      MemoryStore[key] = value;
      return true;
    },
    async remove(key){
      try{
        if (window.storage && window.storage.delete){
          await window.storage.delete(key, false);
          return;
        }
      }catch(e){}
      try{ localStorage.removeItem(key); return; }catch(e){}
      delete MemoryStore[key];
    }
  };

  /* =====================================================================
     SESSION STORE
     A "session" = one full saved Jeopardy board (title, categories, clues,
     teams & scores). We keep a lightweight index of all sessions plus one
     key per session body, and a pointer to whichever session is active.
     ===================================================================== */
  const INDEX_KEY = 'jp_sessions_index';
  const CURRENT_KEY = 'jp_current_session_id';
  const SESSION_KEY = id => 'jp_session_' + id;
  const LEGACY_KEY = 'jeopardy_state_v1'; 

  function newId(){ return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7); }
  function timestamp(){ return Date.now(); }
  function formatDate(ts){
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + ' · ' +
           d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }

  function blankClue(){ return { question:'', answer:'', imageUrl:'', videoUrl:'', audioUrl:'', used:false }; }
  
  function blankCategory(name, valuesArray){
    const targetValues = valuesArray || [100, 200, 300, 400, 500];
    return { 
      id: 'cat_' + Math.random().toString(36).slice(2,9), 
      name, 
      clues: targetValues.reduce((acc, v) => { acc[v] = blankClue(); return acc; }, {}) 
    };
  }

  function defaultSessionData(name){
    const initialValues = [100, 200, 300, 400, 500];
    return {
      title: 'JEOPARDY',
      values: initialValues,
      categories: ["Category", "Category", "Category", "Category", "Category"].map(n => blankCategory(n, initialValues)),
      teams: [
        {id: 't1', name: 'Team 1', score: 0},
        {id: 't2', name: 'Team 2', score: 0},
        {id: 't3', name: 'Team 3', score: 0}
      ]
    };
  }

  const SessionStore = {
    async getIndex(){
      const raw = await Store.get(INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    },
    async saveIndex(index){
      await Store.set(INDEX_KEY, JSON.stringify(index));
    },
    async getCurrentId(){
      return await Store.get(CURRENT_KEY);
    },
    async setCurrentId(id){
      await Store.set(CURRENT_KEY, id);
    },
    async loadSession(id){
      const raw = await Store.get(SESSION_KEY(id));
      return raw ? JSON.parse(raw) : null;
    },
    async saveSession(session){
      session.updatedAt = timestamp();
      await Store.set(SESSION_KEY(session.id), JSON.stringify(session));
      const index = await this.getIndex();
      const meta = {
        id: session.id, name: session.name,
        createdAt: session.createdAt, updatedAt: session.updatedAt,
        categoryCount: session.data.categories.length,
        teamCount: session.data.teams.length
      };
      const idx = index.findIndex(e=>e.id===session.id);
      if (idx >= 0) index[idx] = meta; else index.push(meta);
      await this.saveIndex(index);
    },
    async deleteSession(id){
      await Store.remove(SESSION_KEY(id));
      const index = (await this.getIndex()).filter(e=>e.id!==id);
      await this.saveIndex(index);
    },
    async createSession(name, data){
      const session = { id:newId(), name, createdAt:timestamp(), updatedAt:timestamp(), data: data || defaultSessionData(name) };
      await this.saveSession(session);
      return session;
    },
    async duplicateSession(id, newName){
      const original = await this.loadSession(id);
      if (!original) return null;
      const copy = { id:newId(), name:newName, createdAt:timestamp(), updatedAt:timestamp(), data: JSON.parse(JSON.stringify(original.data)) };
      await this.saveSession(copy);
      return copy;
    },
    async migrateLegacyIfNeeded(){
      const index = await this.getIndex();
      if (index.length > 0) return null; 
      const legacyRaw = await Store.get(LEGACY_KEY);
      if (!legacyRaw) return null;
      let legacyData;
      try{ legacyData = JSON.parse(legacyRaw); }catch(e){ return null; }
      if (!legacyData || !legacyData.categories) return null;
      
      if (!legacyData.values) {
        legacyData.values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      }
      const session = await this.createSession('My First Session', legacyData);
      return session;
    }
  };