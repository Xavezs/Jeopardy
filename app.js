(function(){

  /* =====================================================================
     APP STATE
     ===================================================================== */
  let session = null;      // { id, name, createdAt, updatedAt, data: {...} }
  let state = null;         // shorthand reference to session.data
  let editMode = false;
  let activeClue = null;    // {catId, value}

  let saveIndicatorTimeout;
  function setSaveIndicator(msg){
    const el = document.getElementById('saveIndicator');
    el.textContent = msg;
    clearTimeout(saveIndicatorTimeout);
    saveIndicatorTimeout = setTimeout(()=>{ el.textContent='\u00A0'; }, 1800);
  }

  async function persist(){
    if (!session) return;
    await SessionStore.saveSession(session);
    setSaveIndicator('Saved to "' + session.name + '"');
    renderSessionBar();
  }

  /* =====================================================================
     DIALOGS
     ===================================================================== */
  function showDialog({ title, message, showInput, defaultValue, okLabel, showCancel }){
    return new Promise(resolve=>{
      const overlay = document.getElementById('dialogModalOverlay');
      document.getElementById('dialogTitle').textContent = title || '';
      document.getElementById('dialogMessage').textContent = message || '';
      const inputRow = document.getElementById('dialogInputRow');
      const input = document.getElementById('dialogInput');
      const okBtn = document.getElementById('dialogOkBtn');
      const cancelBtn = document.getElementById('dialogCancelBtn');

      inputRow.style.display = showInput ? 'block' : 'none';
      input.value = showInput ? (defaultValue || '') : '';
      okBtn.textContent = okLabel || 'OK';
      cancelBtn.style.display = showCancel === false ? 'none' : 'inline-block';

      function cleanup(){
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        input.removeEventListener('keydown', onKeydown);
        overlay.classList.add('hidden');
      }
      function onOk(){
        cleanup();
        resolve(showInput ? input.value : true);
      }
      function onCancel(){
        cleanup();
        resolve(showInput ? null : false);
      }
      function onOverlay(e){ if (e.target === overlay) onCancel(); }
      function onKeydown(e){ if (e.key === 'Enter'){ e.preventDefault(); onOk(); } }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
      input.addEventListener('keydown', onKeydown);

      overlay.classList.remove('hidden');
      if (showInput) setTimeout(()=>{ input.focus(); input.select(); }, 30);
    });
  }
  function appPrompt(message, defaultValue){
    return showDialog({ title:'Configuration', message, showInput:true, defaultValue, okLabel:'Save' });
  }
  function appConfirm(message){
    return showDialog({ title:'Are you sure?', message, showInput:false, okLabel:'Confirm' });
  }
  function appAlert(message){
    return showDialog({ title:'Heads up', message, showInput:false, okLabel:'OK', showCancel:false });
  }

  /* =====================================================================
     RENDERING
     ===================================================================== */
  function renderAll(){
    renderTitle();
    renderBoard();
    renderTeams();
    renderSessionBar();
    document.getElementById('editBanner').textContent = editMode ? 'EDIT MODE — click any cell to edit its clue, edit headers, or add/delete rows and columns' : '';
    document.getElementById('editToggleBtn').textContent = editMode ? '✓ Done Editing' : '✎ Edit Board';
  }

  function renderSessionBar(){
    const bar = document.getElementById('sessionBar');
    if (!session){ bar.textContent = ''; return; }
    bar.innerHTML = 'Session: <b>' + escapeHtml(session.name) + '</b> · last saved ' + formatDate(session.updatedAt);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderTitle(){
    const input = document.getElementById('titleInput');
    input.value = state.title;
    input.disabled = !editMode;
  }

  function renderBoard(){
    const board = document.getElementById('board');
    board.innerHTML = '';
    
    if(!state.values) { state.values = [100, 200, 300, 400, 500]; }
    
    const nCats = state.categories.length;
    const nRows = state.values.length;
    
    // Set up explicit grid tracks
    if (editMode) {
      board.style.gridTemplateColumns = `74px repeat(${nCats}, 1fr) 66px`;
      board.style.gridTemplateRows = `auto repeat(${nRows}, 1fr) auto`;
    } else {
      board.style.gridTemplateColumns = `repeat(${nCats}, 1fr)`;
      board.style.gridTemplateRows = `auto repeat(${nRows}, 1fr)`;
    }

    // 2. Category headers (Row 1, Columns start at 2 in edit mode)
    state.categories.forEach((cat, catIndex)=>{
      const cell = document.createElement('div');
      cell.className = 'cat-cell';
      cell.style.gridRow = '1';
      cell.style.gridColumn = editMode ? `${catIndex + 2}` : `${catIndex + 1}`;
      
      if (editMode){
        const input = document.createElement('input');
        input.className = 'cat-name-input';
        input.value = cat.name;
        input.maxLength = 30;
        input.addEventListener('change', ()=>{ cat.name = input.value || 'Category'; persist(); });
        cell.appendChild(input);
        
        const rm = document.createElement('button');
        rm.className = 'cat-remove';
        rm.textContent = '✕';
        rm.title = 'Remove this category';
        rm.addEventListener('click', async ()=>{
          if(state.categories.length <= 1) {
            appAlert("You must keep at least one column category!");
            return;
          }
          if (await appConfirm(`Delete column "${cat.name || 'Category'}" and all its contained clues?`)) {
            state.categories = state.categories.filter(c=>c.id!==cat.id);
            renderAll();  // update the screen immediately
            persist();    // save in the background
          }
        });
        cell.appendChild(rm);
      } else {
        const name = document.createElement('div');
        name.className = 'cat-name';
        name.textContent = cat.name;
        cell.appendChild(name);
      }
      board.appendChild(cell);
    });

    // 3. Add Column button (Far right column, spans all value rows)
    if (editMode) {
      const addCatCell = document.createElement('div');
      addCatCell.className = 'grid-add-column-cell';
      addCatCell.style.gridColumn = `${nCats + 2}`; 
      addCatCell.style.gridRow = `1 / span ${nRows + 1}`;
      
      const btn = document.createElement('button');
      btn.textContent = '+';
      btn.title = 'Add Category Column';
      btn.addEventListener('click', () => {
        state.categories.push(blankCategory('New Category', state.values));
        persist();
        renderAll(); // FIX: Changed from renderBoard()
      });
      addCatCell.appendChild(btn);
      board.appendChild(addCatCell);
    }

    // 4. Clue rows and row settings
    state.values.forEach((v, rowIndex)=>{
      const gridRowPosition = rowIndex + 2;

      // Row management controls (Left side, Column 1)
      if (editMode) {
        const rowControl = document.createElement('div');
        rowControl.className = 'row-control-cell';
        rowControl.style.gridRow = `${gridRowPosition}`;
        rowControl.style.gridColumn = '1';
        
        const deleteRowBtn = document.createElement('button');
        deleteRowBtn.className = 'row-delete-btn';
        deleteRowBtn.innerHTML = '<span class="icon">✕</span><span>Delete</span>';
        deleteRowBtn.title = "Delete this row value pattern";
        deleteRowBtn.addEventListener('click', async () => {
          if (state.values.length <= 1) {
            appAlert("You must keep at least one row!");
            return;
          }
          if (await appConfirm(`Remove the entire $${v} row? All clue data inside it across columns will be lost.`)) {
            state.values = state.values.filter(val => val !== v);
            state.categories.forEach(c => { delete c.clues[v]; });
            renderAll();  // update the screen immediately
            persist();    // save in the background
          }
        });
        
        const editRowBtn = document.createElement('button');
        editRowBtn.className = 'row-edit-btn';
        editRowBtn.innerHTML = '<span class="icon">$</span><span>Value</span>';
        editRowBtn.title = "Change value score amount";
        editRowBtn.addEventListener('click', async () => {
          const newValStr = await appPrompt(`Change points score value for this entire row level:`, v);
          if (newValStr === null) return;
          const newVal = parseInt(newValStr, 10);
          if (isNaN(newVal) || newVal <= 0) {
            appAlert("Please enter a valid positive number.");
            return;
          }
          if (state.values.includes(newVal)) {
            appAlert("A row tier with that point size value already exists.");
            return;
          }
          
          const oldIndex = state.values.indexOf(v);
          state.values[oldIndex] = newVal;
          state.categories.forEach(c => {
            if (c.clues[v]) {
              c.clues[newVal] = c.clues[v];
              delete c.clues[v];
            }
          });
          state.values.sort((a, b) => a - b);
          renderAll();  // update the screen immediately
          persist();    // save in the background
        });
        
        rowControl.appendChild(editRowBtn);
        rowControl.appendChild(deleteRowBtn);
        board.appendChild(rowControl);
      }

      // Main clue cells (Explicit Row and Column assignment)
      state.categories.forEach((cat, catIndex)=>{
        if (!cat.clues[v]) {
          cat.clues[v] = { question:'', answer:'', imageUrl:'', videoUrl:'', audioUrl:'', used:false };
        }
        const clue = cat.clues[v];
        const cell = document.createElement('div');
        cell.className = 'clue-cell' + (clue.used ? ' used' : '') + (editMode ? ' edit-mode-cell' : '');
        
        // Target positioning locks
        cell.style.gridRow = `${gridRowPosition}`;
        cell.style.gridColumn = editMode ? `${catIndex + 2}` : `${catIndex + 1}`;
        
        const valEl = document.createElement('div');
        valEl.className = 'clue-value';
        valEl.textContent = '$' + v;
        cell.appendChild(valEl);
        if (clue.imageUrl || clue.videoUrl || clue.audioUrl){
          const dot = document.createElement('div');
          dot.className = 'media-dot';
          dot.textContent = '●';
          cell.appendChild(dot);
        }
        cell.addEventListener('click', ()=>{
          if (editMode){ openEditModal(cat, v); }
          else if (!clue.used){ openClueModal(cat, v); }
        });
        board.appendChild(cell);
      });
    });

    // 5. Add Row button (Bottom, Spans across column tracks)
    if (editMode) {
      const addRowCell = document.createElement('div');
      addRowCell.className = 'grid-add-row-cell';
      addRowCell.style.gridColumn = `1 / span ${nCats + 1}`;
      addRowCell.style.gridRow = `${nRows + 2}`;
      
      const btn = document.createElement('button');
      btn.textContent = '+';
      btn.title = 'Add Value Row';
      btn.addEventListener('click', async () => {
        let nextSuggested = 100;
        if (state.values && state.values.length > 0) {
          const highest = Math.max(...state.values);
          nextSuggested = highest + 100;
        }
        const valStr = await appPrompt("Enter point allocation value score for the new row level:", nextSuggested);
        if (valStr === null) return;
        const val = parseInt(valStr, 10);
        if (isNaN(val) || val <= 0) {
          appAlert("Please enter a valid positive score number.");
          return;
        }
        if (state.values.includes(val)) {
          appAlert("A row tier with that score value already exists!");
          return;
        }

        state.values.push(val);
        state.values.sort((a, b) => a - b);
        
        state.categories.forEach(c => {
          c.clues[val] = { question:'', answer:'', imageUrl:'', videoUrl:'', audioUrl:'', used:false };
        });

        renderAll();  // update the screen immediately
        persist();    // save in the background
      });
      addRowCell.appendChild(btn);
      board.appendChild(addRowCell);
    }
  }
  
  function renderTeams(){
    const wrap = document.getElementById('teamsWrap');
    wrap.innerHTML = '';
    state.teams.forEach(team=>{
      const card = document.createElement('div');
      card.className = 'team-card';

      if (editMode && state.teams.length > 1){
        const rm = document.createElement('button');
        rm.className = 'team-remove';
        rm.textContent = '✕';
        rm.title = 'Remove this team';
        rm.addEventListener('click', ()=>{
          state.teams = state.teams.filter(t=>t.id!==team.id);
          persist(); renderTeams();
        });
        card.appendChild(rm);
      }

      const nameInput = document.createElement('input');
      nameInput.className = 'team-name-input';
      nameInput.value = team.name;
      nameInput.maxLength = 24;
      nameInput.addEventListener('change', ()=>{ team.name = nameInput.value || 'Team'; persist(); renderClueScoreRowIfOpen(); });
      card.appendChild(nameInput);

      const scoreRow = document.createElement('div');
      scoreRow.className = 'team-score-row';

      const plus = document.createElement('button');
      plus.className = 'plus'; plus.textContent = '+';
      plus.addEventListener('click', ()=>{ team.score += 100; persist(); renderTeams(); renderClueScoreRowIfOpen(); });

      const score = document.createElement('input');
      score.className = 'team-score-input';
      score.type = 'number';
      score.step = '1';
      score.value = team.score;
      score.disabled = !editMode;
      score.addEventListener('change', ()=>{
        const parsed = parseInt(score.value, 10);
        team.score = isNaN(parsed) ? 0 : parsed;
        score.value = team.score;
        renderTeams();  // update the screen immediately
        persist();      // save in the background
        renderClueScoreRowIfOpen();
      });

      const minus = document.createElement('button');
      minus.className = 'minus'; minus.textContent = '−';
      minus.addEventListener('click', ()=>{ team.score -= 100; persist(); renderTeams(); renderClueScoreRowIfOpen(); });

      scoreRow.appendChild(plus);
      scoreRow.appendChild(score);
      scoreRow.appendChild(minus);
      card.appendChild(scoreRow);

      wrap.appendChild(card);
    });

    if (editMode){
      // "+ Add Team" card, styled like the row/category add buttons — edit mode only
      const addCard = document.createElement('div');
      addCard.className = 'team-add-card';
      const addBtn = document.createElement('button');
      addBtn.textContent = '+';
      addBtn.title = 'Add Team';
      addBtn.addEventListener('click', ()=>{
        state.teams.push({ id:'t_'+Math.random().toString(36).slice(2,9), name:'Team '+(state.teams.length+1), score:0 });
        renderTeams();  // update the screen immediately
        persist();      // save in the background
      });
      addCard.appendChild(addBtn);
      wrap.appendChild(addCard);
    }
  }

  function renderClueScoreRowIfOpen(){ if (activeClue) renderClueScoreRow(); }

  /* =====================================================================
     CLUE PLAY MODAL
     ===================================================================== */
  function youTubeEmbed(url){
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{6,})/);
    return m ? `https://www.youtube.com/embed/${m[1]}` : null;
  }

  function openClueModal(cat, value){
    const clue = cat.clues[value];
    activeClue = { catId: cat.id, value };
    document.getElementById('clueModalCategory').textContent = cat.name;
    document.getElementById('clueModalValue').textContent = '$' + value;
    document.getElementById('clueModalQuestion').textContent = clue.question || '(no question text set — edit this clue in Edit Board mode)';

    const mediaEl = document.getElementById('clueModalMedia');
    mediaEl.innerHTML = '';
    mediaEl.style.flexDirection = 'column';
    mediaEl.style.gap = '14px';

    if (clue.imageUrl){
      const img = document.createElement('img'); img.src = clue.imageUrl; mediaEl.appendChild(img);
    }
    if (clue.videoUrl){
      const embed = youTubeEmbed(clue.videoUrl);
      if (embed){
        const iframe = document.createElement('iframe');
        iframe.src = embed; iframe.allow = 'autoplay; encrypted-media; picture-in-picture'; iframe.allowFullscreen = true;
        mediaEl.appendChild(iframe);
      } else {
        const vid = document.createElement('video'); vid.src = clue.videoUrl; vid.controls = true; mediaEl.appendChild(vid);
      }
    }
    if (clue.audioUrl){
      const aud = document.createElement('audio'); aud.src = clue.audioUrl; aud.controls = true; aud.style.width='100%'; mediaEl.appendChild(aud);
    }

    const answerBox = document.getElementById('clueModalAnswerBox');
    answerBox.textContent = clue.answer || '(no answer set)';
    answerBox.classList.remove('show');
    document.getElementById('revealBtn').textContent = 'Reveal Answer';
    document.getElementById('revealBtn').dataset.revealed = 'false';

    renderClueScoreRow();
    document.getElementById('clueModalOverlay').classList.remove('hidden');
  }

  function renderClueScoreRow(){
    const row = document.getElementById('clueScoreRow');
    row.innerHTML = '';
    const value = parseInt(activeClue.value, 10);
    state.teams.forEach(team=>{
      const block = document.createElement('div');
      block.className = 'score-team-block';
      const name = document.createElement('div');
      name.className = 'name'; name.textContent = team.name;
      block.appendChild(name);
      const btns = document.createElement('div');
      btns.className = 'btns';
      const plus = document.createElement('button');
      plus.className = 'plus'; plus.textContent = '+' + value;
      plus.addEventListener('click', ()=>{ team.score += value; persist(); renderTeams(); });
      const minus = document.createElement('button');
      minus.className = 'minus'; minus.textContent = '−' + value;
      minus.addEventListener('click', ()=>{ team.score -= value; persist(); renderTeams(); });
      btns.appendChild(plus); btns.appendChild(minus);
      block.appendChild(btns);
      row.appendChild(block);
    });
  }

  function closeClueModal(markUsed){
    if (markUsed && activeClue){
      const cat = state.categories.find(c=>c.id===activeClue.catId);
      if (cat) cat.clues[activeClue.value].used = true;
      persist();
      renderBoard();
    }
    activeClue = null;
    document.getElementById('clueModalOverlay').classList.add('hidden');
  }

  document.getElementById('revealBtn').addEventListener('click', function(){
    const box = document.getElementById('clueModalAnswerBox');
    const revealed = this.dataset.revealed === 'true';
    box.classList.toggle('show', !revealed);
    this.textContent = revealed ? 'Reveal Answer' : 'Hide Answer';
    this.dataset.revealed = revealed ? 'false' : 'true';
  });
  document.getElementById('closeClueBtn').addEventListener('click', ()=>closeClueModal(true));
  document.getElementById('clueModalOverlay').addEventListener('click', (e)=>{
    if (e.target.id === 'clueModalOverlay') closeClueModal(false);
  });

  /* =====================================================================
     CLUE EDIT MODAL + FILE UPLOADS
     ===================================================================== */
  const MEDIA_TYPES = ['image','video','audio'];
  let fileOverride = { image:null, video:null, audio:null };
  let removedFlag  = { image:false, video:false, audio:false };
  let keepExisting = { image:null, video:null, audio:null };
  let editingTarget = null; 

  function isDataUrl(s){ return typeof s === 'string' && s.indexOf('data:') === 0; }
  function humanSize(bytes){ return bytes > 1024*1024 ? (bytes/(1024*1024)).toFixed(1)+' MB' : Math.round(bytes/1024)+' KB'; }
  function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  function setupFileInput(type){
    const fileInput = document.getElementById('edit' + cap(type) + 'File');
    const urlInput = document.getElementById('edit' + cap(type) + 'Url');
    const status = document.getElementById('edit' + cap(type) + 'FileStatus');
    const clearBtn = document.getElementById('edit' + cap(type) + 'FileClear');

    fileInput.addEventListener('change', async ()=>{
      const file = fileInput.files[0];
      if (!file) return;
      const proceed = file.size < 8*1024*1024 || await appConfirm(
        `"${file.name}" is ${humanSize(file.size)}. Large files may be slow to save or might not persist after a refresh. Use it anyway?`
      );
      if (!proceed){ fileInput.value = ''; return; }
      const reader = new FileReader();
      reader.onload = ()=>{
        fileOverride[type] = reader.result;
        removedFlag[type] = false;
        urlInput.value = '';
        urlInput.disabled = true;
        status.textContent = `📎 ${file.name} (${humanSize(file.size)})`;
      };
      reader.onerror = ()=>{ appAlert('Could not read that file.'); };
      reader.readAsDataURL(file);
    });

    clearBtn.addEventListener('click', ()=>{
      fileOverride[type] = null;
      keepExisting[type] = null;
      removedFlag[type] = true;
      fileInput.value = '';
      urlInput.disabled = false;
      urlInput.value = '';
      status.textContent = '';
    });
  }
  MEDIA_TYPES.forEach(setupFileInput);

  function resetMediaEditState(clue){
    fileOverride = { image:null, video:null, audio:null };
    removedFlag  = { image:false, video:false, audio:false };
    keepExisting = { image:null, video:null, audio:null };
    MEDIA_TYPES.forEach(type=>{
      const urlInput = document.getElementById('edit' + cap(type) + 'Url');
      const status = document.getElementById('edit' + cap(type) + 'FileStatus');
      const fileInput = document.getElementById('edit' + cap(type) + 'File');
      fileInput.value = '';
      urlInput.disabled = false;
      const existing = clue[type + 'Url'] || '';
      if (isDataUrl(existing)){
        keepExisting[type] = existing;
        urlInput.value = '';
        urlInput.disabled = true;
        status.textContent = '📎 File attached (from earlier) — remove to replace';
      } else {
        urlInput.value = existing;
        status.textContent = '';
      }
    });
  }

  function resolveMediaValue(type){
    if (fileOverride[type]) return fileOverride[type];
    if (removedFlag[type]) return '';
    if (keepExisting[type]) return keepExisting[type];
    return document.getElementById('edit' + cap(type) + 'Url').value.trim();
  }

  function openEditModal(cat, value){
    editingTarget = { catId: cat.id, value };
    const clue = cat.clues[value];
    document.getElementById('editQuestion').value = clue.question || '';
    document.getElementById('editAnswer').value = clue.answer || '';
    resetMediaEditState(clue);
    document.getElementById('editModalOverlay').classList.remove('hidden');
  }

  document.getElementById('saveClueBtn').addEventListener('click', ()=>{
    if (!editingTarget) return;
    const cat = state.categories.find(c=>c.id===editingTarget.catId);
    if (cat){
      const clue = cat.clues[editingTarget.value];
      clue.question = document.getElementById('editQuestion').value.trim();
      clue.answer = document.getElementById('editAnswer').value.trim();
      clue.imageUrl = resolveMediaValue('image');
      clue.videoUrl = resolveMediaValue('video');
      clue.audioUrl = resolveMediaValue('audio');
      persist();
      renderBoard();
    }
    document.getElementById('editModalOverlay').classList.add('hidden');
    editingTarget = null;
  });
  document.getElementById('cancelEditBtn').addEventListener('click', ()=>{
    document.getElementById('editModalOverlay').classList.add('hidden');
    editingTarget = null;
  });
  document.getElementById('editModalOverlay').addEventListener('click', (e)=>{
    if (e.target.id === 'editModalOverlay'){
      document.getElementById('editModalOverlay').classList.add('hidden');
      editingTarget = null;
    }
  });

  /* =====================================================================
     SESSIONS MODAL
     ===================================================================== */
  async function openSessionsModal(){
    await renderSessionList();
    document.getElementById('sessionsModalOverlay').classList.remove('hidden');
  }
  function closeSessionsModal(){
    document.getElementById('sessionsModalOverlay').classList.add('hidden');
  }

  async function renderSessionList(){
    const listEl = document.getElementById('sessionList');
    listEl.innerHTML = '';
    const index = (await SessionStore.getIndex()).slice().sort((a,b)=>b.updatedAt-a.updatedAt);
    if (index.length === 0){
      listEl.innerHTML = '<div class="empty-note">No saved sessions yet.</div>';
      return;
    }
    index.forEach(meta=>{
      const row = document.createElement('div');
      row.className = 'session-row' + (session && session.id===meta.id ? ' current' : '');

      const info = document.createElement('div');
      info.className = 'session-info';
      const nameInput = document.createElement('input');
      nameInput.className = 'session-name-input';
      nameInput.value = meta.name;
      nameInput.addEventListener('change', async ()=>{
        const full = await SessionStore.loadSession(meta.id);
        if (full){
          full.name = nameInput.value || 'Untitled Session';
          await SessionStore.saveSession(full);
          if (session && session.id === meta.id){ session.name = full.name; renderSessionBar(); }
          renderSessionList();
        }
      });
      info.appendChild(nameInput);
      const metaLine = document.createElement('div');
      metaLine.className = 'session-meta';
      metaLine.textContent = (meta.categoryCount||0) + ' categories · ' + (meta.teamCount||0) + ' teams · updated ' + formatDate(meta.updatedAt);
      info.appendChild(metaLine);
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'session-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'load';
      loadBtn.textContent = (session && session.id===meta.id) ? 'Current' : 'Load';
      loadBtn.disabled = (session && session.id===meta.id);
      loadBtn.addEventListener('click', async ()=>{
        await switchToSession(meta.id);
        closeSessionsModal();
      });
      actions.appendChild(loadBtn);

      const dupBtn = document.createElement('button');
      dupBtn.textContent = 'Duplicate';
      dupBtn.addEventListener('click', async ()=>{
        const copy = await SessionStore.duplicateSession(meta.id, meta.name + ' (copy)');
        if (copy) renderSessionList();
      });
      actions.appendChild(dupBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async ()=>{
        if (!await appConfirm('Delete session "' + meta.name + '"? This cannot be undone.')) return;
        await SessionStore.deleteSession(meta.id);
        if (session && session.id === meta.id){
          const remaining = await SessionStore.getIndex();
          if (remaining.length > 0){
            await switchToSession(remaining[0].id);
          } else {
            await createAndSwitchToNewSession('Session 1');
          }
        }
        renderSessionList();
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  async function switchToSession(id){
    const loaded = await SessionStore.loadSession(id);
    if (!loaded) return;
    session = loaded;
    state = session.data;
    migrateClueSchemaIfNeeded();
    await SessionStore.setCurrentId(id);
    editMode = false;
    activeClue = null;
    renderAll();
  }

  async function createAndSwitchToNewSession(name){
    const created = await SessionStore.createSession(name);
    session = created;
    state = session.data;
    await SessionStore.setCurrentId(session.id);
    editMode = true;
    renderAll();
  }

  document.getElementById('sessionsBtn').addEventListener('click', openSessionsModal);
  document.getElementById('closeSessionsModalBtn').addEventListener('click', closeSessionsModal);
  document.getElementById('sessionsModalOverlay').addEventListener('click', (e)=>{
    if (e.target.id === 'sessionsModalOverlay') closeSessionsModal();
  });
  document.getElementById('createSessionInModalBtn').addEventListener('click', async ()=>{
    const index = await SessionStore.getIndex();
    const name = await appPrompt('What should this session be called?', 'Session ' + (index.length + 1));
    if (name === null) return;
    await createAndSwitchToNewSession(name.trim() || ('Session ' + (index.length + 1)));
    closeSessionsModal();
  });

  /* =====================================================================
     TOOLBAR & GRID EXTENSIONS
     ===================================================================== */
  document.getElementById('editToggleBtn').addEventListener('click', ()=>{ editMode = !editMode; renderAll(); });
  document.getElementById('titleInput').addEventListener('change', (e)=>{
    state.title = e.target.value || 'GAME NIGHT';
    persist();
  });

  // (Row adding is handled by the "+" button inside the board grid itself, below the last row.)
  // (Team adding is handled by the "+" card next to the last team, below the board.)

  document.getElementById('resetRoundBtn').addEventListener('click', async ()=>{
    if (!await appConfirm('Reset all scores to 0 and mark all clues unused in this session? Your questions/answers/media stay.')) return;
    state.categories.forEach(cat=>{ state.values.forEach(v=>{ if(cat.clues[v]) cat.clues[v].used = false; }); });
    state.teams.forEach(t=> t.score = 0);
    persist();
    renderAll();
  });
  function migrateClueSchemaIfNeeded(){
    if (!state.values) {
      state.values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    }
    state.categories.forEach(cat=>{
      state.values.forEach(v=>{
        const clue = cat.clues[v];
        if (!clue) { cat.clues[v] = { question:'', answer:'', imageUrl:'', videoUrl:'', audioUrl:'', used:false }; return; }
        if (clue.mediaType !== undefined){
          if (clue.mediaType === 'image') clue.imageUrl = clue.mediaUrl || '';
          if (clue.mediaType === 'video' || clue.mediaType === 'youtube') clue.videoUrl = clue.mediaUrl || '';
          if (clue.mediaType === 'audio') clue.audioUrl = clue.mediaUrl || '';
          delete clue.mediaType;
          delete clue.mediaUrl;
        }
        if (clue.imageUrl === undefined) clue.imageUrl = '';
        if (clue.videoUrl === undefined) clue.videoUrl = '';
        if (clue.audioUrl === undefined) clue.audioUrl = '';
      });
    });
  }

  /* =====================================================================
     INIT
     ===================================================================== */
  (async function init(){
    await SessionStore.migrateLegacyIfNeeded();

    let index = await SessionStore.getIndex();
    let currentId = await SessionStore.getCurrentId();

    if (index.length === 0){
      const created = await SessionStore.createSession('Session 1');
      session = created;
      currentId = created.id;
      await SessionStore.setCurrentId(currentId);
    } else {
      const validCurrent = currentId && index.some(e=>e.id===currentId);
      const idToLoad = validCurrent ? currentId : index.slice().sort((a,b)=>b.updatedAt-a.updatedAt)[0].id;
      session = await SessionStore.loadSession(idToLoad);
      await SessionStore.setCurrentId(idToLoad);
    }

    state = session.data;
    migrateClueSchemaIfNeeded();
    renderAll();
  })();

})();