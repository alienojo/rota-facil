(() => {
  'use strict';
  /* RotaFácil V17: redesenho da arquitetura do mapa.
     Pontos, números, linha e GPS são fontes GeoJSON desenhadas no mesmo canvas WebGL.
     Não usamos maplibregl.Marker, elementos HTML sobre coordenadas ou CSS transforms para pinos. */
  const CFG = {
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
    photon: 'https://photon.komoot.io/api/',
    osrm: 'https://router.project-osrm.org',
    debounceMs: 470,
    maxTable: 22,
    timeout: 12000,
    defaultOrigin: { endereco: 'São José dos Campos, SP', lat: -23.1794, lon: -45.8869, personalizado: false }
  };
  const STORAGE = {
    stops: 'rotafacil_paradas', origin: 'rotafacil_origem',
    started: 'rotafacil_iniciada', plan: 'rotafacil_v9_rota', area: 'rotafacil_v9_area'
  };
  const $ = id => document.getElementById(id);
  const ui = {
    tabs: [...document.querySelectorAll('[data-view]')],
    panels: { entregas: $('panel-entregas'), mapa: $('panel-mapa'), resumo: $('panel-resumo') },
    title: $('page-title'), topProgress: $('top-progress'), navCount: $('nav-counter'), count: $('stop-count'),
    form: $('address-form'), input: $('address-input'), suggest: $('address-suggestions'),
    feedback: $('address-feedback'), add: $('add-button'), addLabel: $('add-button-label'),
    editCancel: $('cancel-edit'), city: $('city-input'), uf: $('uf-input'),
    scan: $('scan-button'), scanLabel: $('scan-label'), scanFile: $('scan-file'),
    optimize: $('optimize-button'), start: $('start-button'), toMap: $('view-map-button'), actionHint: $('action-hint'),
    openMap: $('open-map-button'), list: $('stops-list'), listDetail: $('list-detail'),
    clearComplete: $('clear-complete'), clearAll: $('clear-all'),
    map: $('map'), mapError: $('map-error'), mapStatus: $('map-status'),
    gps: $('gps-button'), fit: $('fit-button'),
    card: $('map-card'), cardClose: $('map-card-close'), cardLabel: $('map-card-label'),
    cardAddress: $('map-card-address'), cardDetail: $('map-card-detail'), cardChoices: $('map-card-choices'),
    cardActions: $('map-card-actions'), cardNav: $('map-card-navigate'), cardDone: $('map-card-done'),
    dock: $('map-dock'), dockKicker: $('dock-kicker'), dockAddress: $('dock-address'),
    dockDetail: $('dock-detail'), dockNav: $('dock-navigate'), dockAction: $('dock-action'),
    mapRouteLabel: $('map-route-label'), mapKm: $('map-km'), mapTime: $('map-time'),
    mapPending: $('map-pending'), sequence: $('map-sequence'),
    originInput: $('origin-input'), originSet: $('origin-set'), originGps: $('origin-gps'), originDescription: $('origin-description'),
    statTotal: $('stat-total'), statPending: $('stat-pending'), statDone: $('stat-done'), statPercent: $('stat-percent'),
    progressBar: $('progress-bar'), summaryRouteTitle: $('summary-route-title'), summaryRouteDescription: $('summary-route-description'), summaryMap: $('summary-open-map'), toast: $('toast')
  };
  const missing = Object.entries(ui).filter(([key, v]) => key !== 'tabs' && (v == null || (key === 'panels' && Object.values(v).some(x => !x))));
  if (missing.length) { console.error('RotaFácil: elementos HTML ausentes', missing.map(([k]) => k)); return; }

  const getSaved = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; } };
  const isPoint = p => p != null && p.lat !== '' && p.lon !== '' && p.lat != null && p.lon != null &&
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normRoad = s => norm(s).replace(/^(rua|avenida|av|travessa|alameda|estrada|rodovia|praca) /,'');
  const fmtNumber = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const html = (tag, cls = '', label = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = String(label); return node; };
  function parsed(text) {
    const raw = String(text || '').trim().replace(/\s+/g, ' ');
    const parts = raw.split(/[—,]/).map(s => s.trim()).filter(Boolean);
    const first = parts[0] || raw;
    const secondNum = parts.length > 1 && /^(?:n[º°o]?\.?\s*)?\d{1,5}[a-z]?$/i.test(parts[1]);
    const match = secondNum ? null : first.match(/^(.*?)\s+(?:n[º°o]?\.?\s*)?(\d{1,5}[a-z]?)$/i);
    if (secondNum) return { road: first, number: parts[1].replace(/^n[º°o]?\.?\s*/i, ''), remainder: parts.slice(2).join(', ') };
    if (match && match[1] && !/^(?:rua|avenida|av\.?|travessa)$/i.test(match[1])) return { road: match[1], number: match[2], remainder: parts.slice(1).join(', ') };
    return { road: first, number: '', remainder: parts.slice(1).join(', ') };
  }
  function normalizeStop(p) {
    if (!isPoint(p) || typeof p.endereco !== 'string' || !p.endereco.trim()) return null;
    // V15/V16 às vezes gravavam o encaixe viário no lugar do imóvel.
    const legacySnap = p.locationChecked && p.precision === 'aproximada' && isPoint({lat:p.propertyLat,lon:p.propertyLon}) &&
      isPoint({lat:p.navLat,lon:p.navLon}) && Math.abs(Number(p.lat) - Number(p.navLat)) < 1e-7 &&
      Math.abs(Number(p.lon) - Number(p.navLon)) < 1e-7;
    const lat = legacySnap ? Number(p.propertyLat) : Number(p.lat);
    const lon = legacySnap ? Number(p.propertyLon) : Number(p.lon);
    const parts = parsed(p.endereco);
    return { id: String(p.id ?? `${Date.now()}-${Math.random()}`), endereco: p.endereco,
      lat, lon, concluida: Boolean(p.concluida), precision: p.precision || p.precisao || 'aproximada',
      road: String(p.road || parts.road), number: String(p.number || parts.number || ''),
      city: String(p.city || p.campos?.cidade || ''), uf: String(p.uf || p.campos?.uf || 'SP'),
      district: String(p.district || p.campos?.bairro || ''), notes: String(p.notes || p.notas || '').slice(0, 200),
      urgent: Boolean(p.urgent || p.urgente),
      // Coordenadas do imóvel são imutáveis durante a otimização.
      propertyLat: Number(isPoint({lat:p.propertyLat,lon:p.propertyLon}) ? p.propertyLat : lat),
      propertyLon: Number(isPoint({lat:p.propertyLat,lon:p.propertyLon}) ? p.propertyLon : lon),
      navLat: Number(isPoint({lat:p.navLat,lon:p.navLon}) ? p.navLat : lat),
      navLon: Number(isPoint({lat:p.navLat,lon:p.navLon}) ? p.navLon : lon),
      roadMatched: Boolean(p.roadMatched), accessConfirmed: Boolean(p.accessConfirmed)
    };
  }
  const rawStops = getSaved(STORAGE.stops, []);
  let stops = (Array.isArray(rawStops) ? rawStops : []).map(normalizeStop).filter(Boolean);
  let origin = getSaved(STORAGE.origin, { ...CFG.defaultOrigin });
  if (!isPoint(origin)) origin = { ...CFG.defaultOrigin };
  origin = { ...origin, lat: Number(origin.lat), lon: Number(origin.lon) };
  const area = getSaved(STORAGE.area, { city: 'São José dos Campos', uf: 'SP' });
  ui.city.value = String(area?.city || 'São José dos Campos');
  ui.uf.value = String(area?.uf || 'SP');
  let plan = getSaved(STORAGE.plan, null);
  let started = Boolean(getSaved(STORAGE.started, false));
  let revision = 0, working = false, editingId = null, selectedSuggestion = null;
  let requestSeq = 0, requestController = null, inputTimer = null, suggestions = [], activeSuggestion = -1;
  let map = null, mapReady = false, mapRequested = false, activeView = 'entregas';
  let focusedStopId = null, cardGroup = [], mapPointFeatures = [];
  let gpsId = null, gpsFix = null, gpsPulseTimer = null, arrivalNotified = null;
  let toastTimer = null;
  const responseCache = new Map();
  let lastSearchAt = 0, photonChain = Promise.resolve();

  function fingerprint() { return JSON.stringify({ origin: [origin.lat, origin.lon], stops: stops.map(p => [p.id, p.lat, p.lon, p.navLat, p.navLon]) }); }
  function legacyFingerprint() { return JSON.stringify({ origin: [origin.lat, origin.lon], stops: stops.map(p => [p.id, p.lat, p.lon, p.navLat, p.navLon, p.concluida]) }); }
  function planValid() { return !!(plan && typeof plan === 'object' && Array.isArray(plan.order) && plan.order.length > 0 && plan.signature === fingerprint()); }
  if (plan && (plan.signature === legacyFingerprint() || plan.signature === fingerprint())) {
    plan.signature = fingerprint();
  } else { plan = null; started = false; }
  function save() {
    try {
      localStorage.setItem(STORAGE.stops, JSON.stringify(stops));
      localStorage.setItem(STORAGE.origin, JSON.stringify(origin));
      localStorage.setItem(STORAGE.started, JSON.stringify(started));
      localStorage.setItem(STORAGE.area, JSON.stringify({ city: ui.city.value.trim(), uf: ui.uf.value.trim().toUpperCase() }));
      if (planValid()) localStorage.setItem(STORAGE.plan, JSON.stringify(plan));
      else localStorage.removeItem(STORAGE.plan);
    } catch (e) { console.error('Falha ao salvar:', e); toast('Não foi possível salvar os dados no navegador.'); }
  }
  function invalidate() { revision++; plan = null; started = false; arrivalNotified = null; }
  function toast(text) { ui.toast.textContent = text; ui.toast.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 4200); }
  function feedback(text, error = false) { ui.feedback.textContent = text; ui.feedback.classList.toggle('error', error); ui.feedback.classList.toggle('good', !error); }
  function buttonBusy(button, busy, text) {
    button.disabled = busy;
    // Never replace innerHTML of the address button: its label is referenced by ui.addLabel.
    // Replacing it detached that node and broke the next editing operation.
    if (button === ui.add) {
      ui.addLabel.textContent = busy ? text : (editingId ? 'Salvar edição' : 'Adicionar');
      return;
    }
    if (busy) { button.dataset.prevText = button.textContent; button.textContent = text; }
    else if (button.dataset.prevText !== undefined) { button.textContent = button.dataset.prevText; delete button.dataset.prevText; }
  }
  function meters(a,b) { const rad=x=>x*Math.PI/180, dlat=rad(b.lat-a.lat), dlon=rad(b.lon-a.lon); const h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 12742000*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h))); }
  const navLink = p => {
    const destination = p.precision === 'exata' && p.accessConfirmed && isPoint({lat:p.navLat,lon:p.navLon})
      ? `${p.navLat},${p.navLon}`
      : `${p.endereco}${p.city && !norm(p.endereco).includes(norm(p.city)) ? `, ${p.city}` : ''}, ${p.uf || 'SP'}, Brasil`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
  };
  const nextStop = () => stops.find(x => !x.concluida) || null;
  function openView(name, focusId = null) {
    activeView = name;
    for (const tab of ui.tabs) {
      const selected = tab.dataset.view === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
    Object.entries(ui.panels).forEach(([view, el]) => { el.hidden = view !== name; });
    ui.title.textContent = ({entregas:'Planejar entregas', mapa:'Seu mapa de rotas', resumo:'Resultados do dia'})[name];
    if (name === 'mapa') {
      ensureMap();
      requestAnimationFrame(() => { if (map) { map.resize(); updateMapSources(); if (focusId) { focusStop(focusId); } } });
      // Resize again once browser has committed tab visibility (critical on mobile).
      setTimeout(() => { if (map && activeView === 'mapa') map.resize(); }, 110);
    }
  }
  ui.tabs.forEach(tab => tab.addEventListener('click', () => openView(tab.dataset.view)));
  ui.openMap.addEventListener('click', () => openView('mapa'));
  ui.toMap.addEventListener('click', () => { openView('mapa'); fitMap(); });
  ui.summaryMap.addEventListener('click', () => openView('mapa'));

  async function requestJSON(url, { signal, timeout = CFG.timeout } = {}) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(), timeout);
    try { const r = await fetch(url, { signal: abort.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  // Um acesso por vez ao Photon público. Nenhuma consulta a cada tecla.
  async function photon(url, signal) {
    const task = async () => {
      if (signal?.aborted) throw new DOMException('Busca cancelada', 'AbortError');
      const waitMs = Math.max(0, 1100 - (Date.now() - lastSearchAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (signal?.aborted) throw new DOMException('Busca cancelada', 'AbortError');
      lastSearchAt = Date.now();
      return requestJSON(url, { signal });
    };
    const job = photonChain.then(task, task);
    photonChain = job.catch(() => {});
    return job;
  }
  function photonURL(query) {
    const q = new URLSearchParams({q: query, limit: '8', lat: String(origin.lat), lon: String(origin.lon)});
    return `${CFG.photon}?${q.toString()}`;
  }
  function isHouseMatch(found, expected) { return !!(expected && found && norm(found) === norm(expected)); }
  function formatFeature(f, number, fallbackCity, uf, requestedRoad = '') {
    const p = f.properties || {}, point = f.geometry?.coordinates;
    if (!Array.isArray(point) || !isPoint({lat:point[1],lon:point[0]})) return null;
    const road = String(p.street || p.name || p.road || '').trim();
    if (!road) return null;
    const city = String(p.city || p.town || p.village || fallbackCity || '').trim();
    const district = String(p.district || p.suburb || p.locality || '').trim();
    const foundNumber = String(p.housenumber || '').trim();
    const outputNumber = number || foundNumber;
    const numberMatched = isHouseMatch(foundNumber, number) && (!requestedRoad || normRoad(road) === normRoad(requestedRoad)) && (!city || norm(city) === norm(fallbackCity));
    const address = [road + (outputNumber ? `, ${outputNumber}` : ''), district, city, p.state || uf].filter(Boolean).join(' — ');
    return { endereco: address, lat: Number(point[1]), lon: Number(point[0]), road, number: outputNumber,
      city, uf, district, precision: numberMatched || (!number && foundNumber) ? 'exata' : 'aproximada' };
  }
  function showSuggestions(items, emptyText = '') {
    suggestions = items; activeSuggestion = -1;
    ui.suggest.replaceChildren();
    items.forEach((s, i) => {
      const btn = html('button', 'suggestion'); btn.type = 'button'; btn.setAttribute('role','option'); btn.dataset.index = i;
      btn.append(html('strong', '', s.road + (s.number ? `, ${s.number}` : '')));
      btn.append(html('small','',[s.district, s.city, s.uf].filter(Boolean).join(' · ') + (s.precision === 'exata' ? ' · Número identificado' : ' · Ponto aproximado')));
      btn.addEventListener('click', () => pickSuggestion(i)); ui.suggest.append(btn);
    });
    if (!items.length && emptyText) ui.suggest.append(html('div','suggestion',emptyText));
    ui.suggest.classList.toggle('hidden', !items.length && !emptyText);
    ui.input.setAttribute('aria-expanded', String(items.length > 0));
  }
  function pickSuggestion(i) {
    const item = suggestions[i]; if (!item) return;
    // Prevent an older autocomplete response from replacing the chosen address.
    requestSeq++; clearTimeout(inputTimer); requestController?.abort();
    selectedSuggestion = {...item};
    ui.input.value = item.endereco;
    showSuggestions([]);
    feedback(item.precision === 'exata' ? 'Número identificado. Pronto para adicionar.' : 'Endereço selecionado. Se a casa não estiver mapeada, a posição é aproximada.');
    ui.add.focus();
  }
  async function lookup(term, seq) {
    if (requestController) requestController.abort();
    requestController = new AbortController();
    const signal = requestController.signal;
    const city = ui.city.value.trim() || 'São José dos Campos', uf = ui.uf.value.trim().toUpperCase() || 'SP';
    const parts = parsed(term);
    const searchBase = `${parts.road}, ${city}, ${uf}, Brasil`;
    const key = norm(`${searchBase}|${parts.number}`);
    feedback('Buscando sugestões...');
    try {
      let items = responseCache.get(key);
      if (!items) {
        // Search by road+number; if unavailable, search just the road.
        let data = await photon(photonURL(parts.number ? `${parts.road} ${parts.number}, ${city}` : searchBase), signal);
        if ((!Array.isArray(data.features) || !data.features.length) && parts.number) data = await photon(photonURL(searchBase), signal);
        items = (data.features || []).map(f => formatFeature(f, parts.number, city, uf, parts.road)).filter(Boolean);
        // Preserve the main road name first; Photon may return unrelated similarly named streets.
        const targetRoad = norm(parts.road);
        items.sort((a, b) => (norm(b.road) === targetRoad ? 1 : 0) - (norm(a.road) === targetRoad ? 1 : 0));
        const unique = new Set();
        items = items.filter(i => { const k = `${norm(i.road)}|${norm(i.city)}|${norm(i.district)}|${i.lat.toFixed(6)}|${i.lon.toFixed(6)}`; if (unique.has(k)) return false; unique.add(k); return true; }).slice(0,7);
        if (responseCache.size > 70) responseCache.clear();
        responseCache.set(key, items);
      }
      if (signal.aborted || seq !== requestSeq) return;
      showSuggestions(items, items.length ? '' : 'Nenhuma sugestão. Confira a rua e a cidade.');
      feedback(items.length ? 'Selecione um endereço na lista.' : 'Não encontramos esse endereço. Tente incluir bairro e cidade.', !items.length);
    } catch (e) {
      if (signal.aborted || seq !== requestSeq) return;
      console.warn('Busca de endereços falhou:', e);
      showSuggestions([], 'Serviço de endereços indisponível. Tente novamente.');
      feedback('Não foi possível consultar endereços agora. Verifique a conexão.', true);
    }
  }
  function queueLookup() {
    selectedSuggestion = null;
    const term = ui.input.value.trim();
    requestSeq++; clearTimeout(inputTimer); requestController?.abort();
    if (term.length < 4) { showSuggestions([]); return; }
    inputTimer = setTimeout(() => lookup(term, requestSeq), CFG.debounceMs);
  }
  ui.input.addEventListener('input', queueLookup);
  ui.input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { showSuggestions([]); return; }
    if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); activeSuggestion=(activeSuggestion+1)%suggestions.length; ui.suggest.querySelectorAll('button')[activeSuggestion]?.focus(); }
  });
  document.addEventListener('pointerdown', e => { if (!ui.form.contains(e.target)) showSuggestions([]); });
  ui.city.addEventListener('change', () => { selectedSuggestion=null; requestSeq++; save(); });
  ui.uf.addEventListener('change', () => { selectedSuggestion=null; requestSeq++; save(); });
  ui.form.addEventListener('submit', async e => {
    e.preventDefault();
    const address = ui.input.value.trim();
    if (address.length < 4) { feedback('Digite um endereço completo.', true); return; }
    buttonBusy(ui.add, true, 'Localizando...');
    try {
      let found = selectedSuggestion?.endereco === address ? selectedSuggestion : null;
      if (!found) {
        // Submit without selecting: resolve once, then add if a result exists.
        const p = parsed(address), city = ui.city.value.trim() || 'São José dos Campos', uf = ui.uf.value.trim().toUpperCase() || 'SP';
        const data = await photon(photonURL(`${p.road} ${p.number}, ${city}`.trim()));
        found = (data.features || []).map(f=>formatFeature(f,p.number,city,uf,p.road)).find(Boolean);
        if (!found) throw new Error('Endereço não encontrado. Escolha uma sugestão da lista.');
        found.endereco = [found.road + (p.number ? `, ${p.number}` : ''), found.district, city, uf].filter(Boolean).join(' — ');
      }
      if (address !== ui.input.value.trim()) throw new Error('O endereço mudou durante a busca. Selecione novamente a sugestão.');
      if (!isPoint(found)) throw new Error('Não recebemos coordenadas válidas para esse endereço.');
      const updated = { ...found, id: editingId || `${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
        concluida: editingId ? Boolean(stops.find(s=>s.id===editingId)?.concluida) : false,
        notes: editingId ? (stops.find(s=>s.id===editingId)?.notes||'') : '', urgent: editingId ? Boolean(stops.find(s=>s.id===editingId)?.urgent) : false,
        propertyLat: found.lat, propertyLon: found.lon, navLat: found.lat, navLon: found.lon,
        accessConfirmed: false, roadMatched: false };
      if (editingId) stops = stops.map(s=>s.id===editingId?updated:s);
      else stops.push(updated);
      const edited = !!editingId;
      resetForm(); invalidate(); save(); render();
      feedback(edited ? 'Endereço atualizado.' : 'Entrega adicionada. Você pode continuar cadastrando.');
      toast(edited?'Endereço atualizado.':'Entrega adicionada.');
    } catch (err) { feedback(err.message || 'Não foi possível cadastrar esse endereço.', true); }
    finally { buttonBusy(ui.add, false); }
  });
  function resetForm() { editingId=null; selectedSuggestion=null; ui.input.value=''; ui.addLabel.textContent='Adicionar'; ui.editCancel.classList.add('hidden'); showSuggestions([]); }
  ui.editCancel.addEventListener('click',()=>{resetForm();feedback('Edição cancelada.');});

  // OCR carrega apenas quando o motorista realmente seleciona uma fotografia.
  ui.scan.addEventListener('click',()=>ui.scanFile.click());
  let ocrLoading = null;
  function ensureOCR() {
    if (window.Tesseract) return Promise.resolve();
    if (ocrLoading) return ocrLoading;
    ocrLoading = new Promise((resolve, reject) => {
      const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';s.async=true;
      s.onload=resolve;s.onerror=()=>reject(new Error('Não foi possível carregar o scanner.'));
      document.head.append(s);
    }).catch(err=>{ocrLoading=null;throw err;});
    return ocrLoading;
  }
  ui.scanFile.addEventListener('change',async()=>{
    const image=ui.scanFile.files?.[0];ui.scanFile.value='';if(!image)return;
    if (!image.type.startsWith('image/')) { feedback('Selecione uma foto de endereço.',true);return; }
    const old=ui.input.value;
    ui.scan.disabled=true;ui.scanLabel.textContent='Lendo...';feedback('Lendo o endereço da foto...');
    try {
      await ensureOCR();
      const result=await window.Tesseract.recognize(image,'por+eng');
      const lines=String(result.data?.text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      const address=lines.find(line=>/\b(rua|avenida|av\.?|travessa|alameda|estrada|rodovia|praça)\b/i.test(line)) || lines.find(l=>/\d/.test(l)) || lines[0];
      if (!address) throw new Error('Não identifiquei um endereço na fotografia.');
      ui.input.value=address.slice(0,200);queueLookup();feedback('Texto lido. Confira o número e escolha a sugestão.');
    } catch(err){ui.input.value=old;feedback(err.message||'Não foi possível ler a foto.',true);}
    finally {ui.scan.disabled=false;ui.scanLabel.textContent='Escanear';}
  });

  function editStop(id) {
    const stop=stops.find(s=>s.id===id);if(!stop)return;
    editingId=id;selectedSuggestion={...stop};ui.input.value=stop.endereco;
    ui.addLabel.textContent='Salvar edição';ui.editCancel.classList.remove('hidden');feedback('Corrija o endereço e clique em Salvar edição.');
    openView('entregas');ui.input.focus();ui.input.scrollIntoView({behavior:'smooth',block:'center'});
  }
  function toggleDone(id) {
    stops = stops.map(p => p.id === id ? {...p, concluida: !p.concluida} : p);
    arrivalNotified=null;save();render();
    if (stops.every(p=>p.concluida) && stops.length) toast('Todas as entregas foram concluídas!');
    else toast('Entrega atualizada.');
  }
  function removeStop(id) {
    const s=stops.find(p=>p.id===id);if(!s)return;
    if(!confirm(`Excluir a entrega: ${s.endereco}?`))return;
    stops=stops.filter(p=>p.id!==id);if(editingId===id)resetForm();
    invalidate(); save();render();
  }
  function listButton(label,fn,cls='') { const b=html('button',cls,label);b.type='button';b.addEventListener('click',fn);return b; }
  function listLink(label, url) { const a=html('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a; }
  function renderList() {
    ui.list.replaceChildren();
    const coincident = new Map();
    stops.forEach(s => { const key=`${s.lat.toFixed(6)}:${s.lon.toFixed(6)}`; coincident.set(key,(coincident.get(key)||0)+1); });
    const next=started?nextStop():null;
    if(!stops.length) ui.list.append(html('div','empty-state','Sua lista está vazia. Digite uma rua e adicione a primeira parada.'));
    stops.forEach((s,i)=>{
      const card=html('article',`stop-card${s.concluida?' complete':''}${next?.id===s.id?' is-next':''}`);
      card.append(html('span','stop-num',String(i+1)));
      const body=html('div','stop-body');body.append(html('strong','',s.endereco));
      body.append(html('small','',s.concluida?'Concluída':s.precision==='exata'?'Ponto com número identificado':'Posição aproximada — confirme na navegação'));
      if (coincident.get(`${s.lat.toFixed(6)}:${s.lon.toFixed(6)}`)>1) body.append(html('small','warn','⚠ Este ponto é compartilhado com outra entrega. O número não foi confirmado.')); 
      const actions=html('div','stop-actions');
      actions.append(listButton('⌖ Mapa',()=>openView('mapa',s.id)),listLink('↗ Navegar',navLink(s)),listButton(s.concluida?'↶ Desfazer':'✓ Entregue',()=>toggleDone(s.id),'done-button'),listButton('✎ Editar',()=>editStop(s.id)),listButton('×',()=>removeStop(s.id),'del-button'));
      card.append(body,actions);ui.list.append(card);
    });
  }
  ui.clearComplete.addEventListener('click',()=>{if(!stops.some(p=>p.concluida)){toast('Não há entregas concluídas.');return;}if(!confirm('Remover todas as entregas concluídas?'))return;stops=stops.filter(p=>!p.concluida);invalidate();save();render();});
  ui.clearAll.addEventListener('click',()=>{if(!stops.length)return;if(!confirm('Apagar todas as entregas da lista?'))return;stops=[];resetForm();invalidate();closeCard();save();render();});

  function matrixGeo(points) { return points.map(a => points.map(b => meters(a,b))); }
  async function matrixRoad(points) {
    const coords=points.map(p=>`${p.lon},${p.lat}`).join(';');
    const d=await requestJSON(`${CFG.osrm}/table/v1/driving/${coords}?annotations=duration`,{timeout:17000});
    if(d.code!=='Ok'||!Array.isArray(d.durations))throw new Error('Matriz rodoviária indisponível');
    return d.durations;
  }
  function cost(order,matrix){let sum=0,p=0;for(const i of order){sum+=Number.isFinite(matrix[p]?.[i])?matrix[p][i]:1e10;p=i;}return sum;}
  function orderRoute(matrix,n){const remaining=Array.from({length:n},(_,i)=>i+1);const order=[];let current=0;
    while(remaining.length){let best=0,min=Infinity;remaining.forEach((j,i)=>{let d=matrix[current]?.[j];if(Number.isFinite(d)&&d<min){min=d;best=i;}});current=remaining.splice(best,1)[0];order.push(current);}
    let best=order,bestScore=cost(best,matrix),improving=true,pass=0;
    while(improving && pass++<5){improving=false;for(let i=0;i<best.length-1;i++)for(let j=i+1;j<best.length;j++){const candidate=[...best.slice(0,i),...best.slice(i,j+1).reverse(),...best.slice(j+1)];const score=cost(candidate,matrix);if(score+1e-9<bestScore){best=candidate;bestScore=score;improving=true;}}}
    return best;
  }
  async function routeRoad(points) {
    const coords=points.map(p=>`${p.lon},${p.lat}`).join(';');
    const d=await requestJSON(`${CFG.osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`,{timeout:18000});
    if(d.code!=='Ok'||!d.routes?.[0]?.geometry?.coordinates)throw new Error('Traçado não encontrado');
    return d.routes[0];
  }
  ui.optimize.addEventListener('click',async()=>{
    if(working)return;
    const pending=stops.filter(s=>!s.concluida);
    if(!pending.length){toast('Cadastre uma entrega pendente para otimizar.');return;}
    const oldRevision=revision, startingSignature=fingerprint();
    working=true;buttonBusy(ui.optimize,true,'Calculando...');renderActions();
    let newOrder=null;
    try{
      const coords=[origin,...pending.map(p=>({lat:p.navLat,lon:p.navLon}))];
      let matrix,roadMatrix=true;
      try{matrix=pending.length<=CFG.maxTable?await matrixRoad(coords):matrixGeo(coords);roadMatrix=pending.length<=CFG.maxTable;}
      catch(e){console.warn('Matriz por ruas não disponível:',e);matrix=matrixGeo(coords);roadMatrix=false;}
      if(oldRevision!==revision||startingSignature!==fingerprint())return;
      newOrder=orderRoute(matrix,pending.length).map(i=>pending[i-1]);
      const routePoints=[origin,...newOrder.map(p=>({lat:p.navLat,lon:p.navLon}))];
      let road=null;
      if(newOrder.length<=CFG.maxTable){try{road=await routeRoad(routePoints);}catch(e){console.warn('Rota viária indisponível:',e);}}
      if(oldRevision!==revision||startingSignature!==fingerprint())return;
      const complete=stops.filter(s=>s.concluida);
      stops=[...complete,...newOrder];
      const estimatedMeters=routePoints.slice(1).reduce((sum,p,i)=>sum+meters(routePoints[i],p),0)*1.3;
      const km=road ? Number(road.distance)/1000 : estimatedMeters/1000;
      const mins=road ? Math.ceil(Number(road.duration)/60):Math.ceil(km/30*60);
      const geometry=road?.geometry?.coordinates || routePoints.map(p=>[p.lon,p.lat]);
      plan={signature:fingerprint(),order:newOrder.map(p=>p.id),km,mins,geometry,roadLine:!!road,approximate:!roadMatrix||!road||newOrder.some(p=>p.precision!=='exata')};
      started=false;save();render();toast(road?'Rota calculada. Abra o mapa para conferir.':'Ordem calculada com estimativa de distância.');
    }catch(err){console.error(err);toast('Não foi possível otimizar agora. Tente novamente.');}
    finally{working=false;buttonBusy(ui.optimize,false);renderActions();}
  });
  function startRoute(){if(!planValid()){toast('Primeiro clique em Otimizar rota.');return;}started=true;save();render();openView('mapa');toast('Rota iniciada!');}
  ui.start.addEventListener('click',startRoute);

  function emptyFC(){return {type:'FeatureCollection',features:[]};}
  function pointFeature(id,lng,lat,props){return {type:'Feature',id,properties:props,geometry:{type:'Point',coordinates:[lng,lat]}};}
  function makePointData(){
    const groups=new Map();
    const originKey='origin';
    const features=[pointFeature(originKey,origin.lon,origin.lat,{ids:'',label:'S',status:'origin',selected:0,origin:1})];
    stops.forEach((p,index)=>{
      const key=`${p.lon.toFixed(6)}:${p.lat.toFixed(6)}`;
      const group=groups.get(key)||[];group.push({stop:p,index});groups.set(key,group);
    });
    groups.forEach((group,key)=>{
      const first=group[0].stop;
      const current=started&&group.some(x=>x.stop.id===nextStop()?.id);
      const status=group.every(x=>x.stop.concluida)?'done':current?'next':group.some(x=>x.stop.precision!=='exata')?'approx':'pending';
      features.push(pointFeature(key,first.lon,first.lat,{ids:JSON.stringify(group.map(x=>x.stop.id)),label:group.length>1?String(group.length):String(group[0].index+1),status,selected:group.some(x=>x.stop.id===focusedStopId)?1:0,origin:0}));
    });
    mapPointFeatures=features;
    return {type:'FeatureCollection',features};
  }
  function routeData(){
    if(!planValid() || !Array.isArray(plan.geometry) || plan.geometry.length<2)return emptyFC();
    return {type:'FeatureCollection',features:[{type:'Feature',properties:{type:'route'},geometry:{type:'LineString',coordinates:plan.geometry}}]};
  }
  function gpsData(){return gpsFix && isPoint(gpsFix)?{type:'FeatureCollection',features:[pointFeature('gps',gpsFix.lon,gpsFix.lat,{id:'gps'})]}:emptyFC();}
  function updateMapSources(){
    if(!mapReady||!map)return;
    const points=map.getSource('rf-points'),line=map.getSource('rf-route'),gps=map.getSource('rf-gps');
    if(points)points.setData(makePointData());
    if(line)line.setData(routeData());
    if(gps)gps.setData(gpsData());
  }
  function addMapLayers(){
    if(!map || map.getSource('rf-points'))return;
    map.addSource('rf-route',{type:'geojson',data:emptyFC()});
    map.addLayer({id:'rf-route-line',type:'line',source:'rf-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#13a278','line-width':5,'line-opacity':0.92}});
    map.addSource('rf-points',{type:'geojson',data:emptyFC()});
    map.addLayer({id:'rf-point-halo',type:'circle',source:'rf-points',paint:{
      'circle-radius':['case',['==',['get','selected'],1],23,0],
      'circle-color':'#d5f779','circle-opacity':0.65,'circle-blur':0.35}});
    map.addLayer({id:'rf-point-circles',type:'circle',source:'rf-points',paint:{
      'circle-radius':['case',['==',['get','status'],'origin'],16,['==',['get','status'],'next'],17,15],
      'circle-color':['match',['get','status'],'origin','#2466a7','next','#e05e4d','done','#94a69c','approx','#b28346','#14866c'],
      'circle-stroke-width':3,'circle-stroke-color':'#ffffff','circle-opacity':1}});
    map.addLayer({id:'rf-point-labels',type:'symbol',source:'rf-points',layout:{'text-field':['get','label'],'text-size':12,'text-font':['Open Sans Bold','Arial Unicode MS Bold'],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#fff','text-halo-width':0}});
    map.addSource('rf-gps',{type:'geojson',data:emptyFC()});
    map.addLayer({id:'rf-gps-halo',type:'circle',source:'rf-gps',paint:{'circle-radius':17,'circle-color':'#2679e7','circle-opacity':0.18,'circle-blur':0.3}});
    map.addLayer({id:'rf-gps-dot',type:'circle',source:'rf-gps',paint:{'circle-radius':8,'circle-color':'#2b80ec','circle-stroke-width':3,'circle-stroke-color':'#fff'}});
    const openPoint=e=>{const f=e.features?.[0];if(f)showFeatureCard(f);};
    for(const layer of ['rf-point-circles','rf-point-labels']){
      map.on('click',layer,openPoint);
      map.on('mouseenter',layer,()=>{map.getCanvas().style.cursor='pointer';});
      map.on('mouseleave',layer,()=>{map.getCanvas().style.cursor='';});
    }
    updateMapSources();
  }
  function ensureMap(){
    if(mapRequested)return;
    mapRequested=true;
    if(typeof window.maplibregl==='undefined'){
      ui.mapError.classList.remove('hidden');ui.mapStatus.textContent='Biblioteca de mapa indisponível.';return;
    }
    try {
      map=new maplibregl.Map({container:'map',style:CFG.mapStyle,center:[origin.lon,origin.lat],zoom:12.4,attributionControl:true});
      map.addControl(new maplibregl.NavigationControl({showCompass:false}),'bottom-right');
      map.on('load',()=>{mapReady=true;addMapLayers();map.resize();fitMap();});
      map.on('error',e=>{console.warn('Aviso do provedor de mapa:',e.error||e);});
      // Context restores/redraws are handled by MapLibre. On a new style, sources must be recreated.
      map.on('style.load',()=>{if(mapReady&&!map.getSource('rf-points'))addMapLayers();});
    } catch(e) {console.error('Falha ao iniciar mapa:',e);ui.mapError.classList.remove('hidden');ui.mapStatus.textContent='Mapa indisponível.';}
  }
  function fitMap(){
    if(!mapReady||!map)return;
    const points=[origin,...stops];
    if(points.length===1)map.easeTo({center:[origin.lon,origin.lat],zoom:13});
    else {const b=new maplibregl.LngLatBounds([points[0].lon,points[0].lat],[points[0].lon,points[0].lat]);
      points.slice(1).forEach(p=>b.extend([p.lon,p.lat]));
      map.fitBounds(b,{padding:{top:65,right:60,bottom:130,left:60},maxZoom:16.5,duration:500});}
  }
  ui.fit.addEventListener('click',fitMap);
  function focusStop(id){
    const p=stops.find(s=>s.id===id);if(!p)return;
    focusedStopId=id;showStopCard(p);
    updateMapSources();
    if(mapReady)map.easeTo({center:[p.lon,p.lat],zoom:Math.max(map.getZoom(),15),duration:350});
  }
  function showFeatureCard(feature){
    if(feature.properties?.origin===1){focusedStopId=null;closeCard();toast('Este é o seu ponto de partida.');return;}
    let ids=[];try{ids=JSON.parse(feature.properties?.ids||'[]');}catch{}
    const group=ids.map(id=>stops.find(s=>s.id===id)).filter(Boolean);
    if(!group.length)return;
    cardGroup=group;
    showStopCard(group[0]);
  }
  function showStopCard(p){
    if(!p)return;
    focusedStopId=p.id;
    ui.card.classList.remove('hidden');ui.dock.classList.add('hidden');
    ui.cardLabel.textContent=`PARADA ${stops.findIndex(s=>s.id===p.id)+1}`;
    ui.cardAddress.textContent=p.endereco;
    ui.cardDetail.textContent=p.concluida?'Entrega concluída':p.precision==='exata'?'Número identificado no mapa':'Localização aproximada: confira o número ao navegar';
    ui.cardNav.href=navLink(p);
    ui.cardDone.textContent=p.concluida?'↶ Desfazer':'✓ Entregue';
    ui.cardDone.onclick=()=>{toggleDone(p.id);const refreshed=stops.find(s=>s.id===p.id);if(refreshed)showStopCard(refreshed);};
    ui.cardChoices.replaceChildren();
    const group=stops.filter(s=>Math.abs(s.lat-p.lat)<1e-6&&Math.abs(s.lon-p.lon)<1e-6);
    if(group.length>1){group.forEach(s=>ui.cardChoices.append(listButton(s.endereco,()=>showStopCard(s))));ui.cardChoices.classList.remove('hidden');}
    else ui.cardChoices.classList.add('hidden');
    updateMapSources();
  }
  function closeCard(){focusedStopId=null;cardGroup=[];ui.card.classList.add('hidden');updateMapSources();updateDock();}
  ui.cardClose.addEventListener('click',closeCard);

  function updateDock(){
    if(focusedStopId){ui.dock.classList.add('hidden');return;}
    const next=nextStop();
    if(!planValid()||!next){ui.dock.classList.add('hidden');return;}
    ui.dock.classList.remove('hidden');
    ui.dockKicker.textContent=started?'PRÓXIMA ENTREGA':'ROTA OTIMIZADA';
    ui.dockAddress.textContent=started?next.endereco:'Sua sequência está pronta';
    ui.dockDetail.textContent=started?`${stops.filter(s=>s.concluida).length} de ${stops.length} concluídas`:`${fmtNumber(plan.km)} km · ${Math.ceil(plan.mins)} min (estimativa)`;
    ui.dockNav.classList.toggle('hidden',!started);ui.dockNav.href=navLink(next);
    ui.dockAction.textContent=started?'✓ Entregue':'▶ Começar rota';
    ui.dockAction.onclick=started?()=>toggleDone(next.id):startRoute;
  }
  function renderMapInfo(){
    const pending=stops.filter(s=>!s.concluida).length;
    ui.mapPending.textContent=String(pending);
    ui.mapKm.textContent=planValid()?`${fmtNumber(plan.km)} km`:'—';
    ui.mapTime.textContent=planValid()?`${Math.ceil(plan.mins)} min`:'—';
    ui.mapRouteLabel.textContent=!planValid()?'Rota ainda não otimizada':started?'Rota em andamento':plan.roadLine?'Trajeto pelas ruas':'Trajeto estimado';
    ui.mapStatus.textContent=planValid()?`${stops.length} paradas · ${fmtNumber(plan.km)} km`:`${stops.length} destinos no mapa`;
    ui.sequence.replaceChildren();
    if(!stops.length)ui.sequence.append(html('div','feedback','Nenhuma entrega na sequência.'));
    stops.forEach((s,i)=>{const b=html('button','');b.type='button';b.append(html('span','',String(i+1)),html('div','',s.endereco));b.addEventListener('click',()=>focusStop(s.id));ui.sequence.append(b);});
    ui.originDescription.textContent=`Origem: ${origin.endereco || 'São José dos Campos'}`;
    ui.originInput.value=origin.personalizado?origin.endereco:'';
    updateDock();
  }
  ui.originSet.addEventListener('click',async()=>{
    const text=ui.originInput.value.trim();if(!text){toast('Digite um endereço de origem.');return;}
    ui.originSet.disabled=true;
    try{const data=await photon(photonURL(`${text}, ${ui.city.value}, ${ui.uf.value}`));
      const feature=(data.features||[]).find(f=>isPoint({lat:f.geometry?.coordinates?.[1],lon:f.geometry?.coordinates?.[0]}));
      if(!feature)throw new Error('Ponto de partida não localizado.');
      origin={endereco:text,lat:Number(feature.geometry.coordinates[1]),lon:Number(feature.geometry.coordinates[0]),personalizado:true};
      invalidate();save();render();fitMap();toast('Origem definida.');
    }catch(e){toast(e.message||'Não foi possível definir a origem.');}finally{ui.originSet.disabled=false;}
  });
  ui.originGps.addEventListener('click',()=>{
    if(!navigator.geolocation){toast('GPS indisponível.');return;}
    navigator.geolocation.getCurrentPosition(pos=>{origin={endereco:'Minha localização GPS',lat:pos.coords.latitude,lon:pos.coords.longitude,personalizado:true};invalidate();save();render();fitMap();toast('Origem atualizada pelo GPS.');},()=>toast('Permita o GPS nas configurações do navegador.'),{enableHighAccuracy:true,timeout:15000});
  });

  function updateGPS(){
    if(!mapReady)return;
    map.getSource('rf-gps')?.setData(gpsData());
    if(gpsFix&&map.getLayer('rf-gps-halo'))map.setPaintProperty('rf-gps-halo','circle-radius',13+(Math.round(Date.now()/1500)%2)*7);
  }
  function checkArrival(){
    if(!started||!gpsFix||gpsFix.accuracy>10)return;
    const next=nextStop();if(!next||next.id===arrivalNotified)return;
    // Não declarar chegada exata quando o número é apenas um ponto aproximado da rua.
    if(next.precision==='exata'&&next.accessConfirmed&&meters(gpsFix,{lat:next.navLat,lon:next.navLon})<=10){arrivalNotified=next.id;toast('Você chegou ao destino. Confirme a entrega.');}
  }
  function beginGPS(){
    if(!navigator.geolocation){toast('GPS não suportado pelo navegador.');return;}
    if(gpsId!==null)return;
    try{gpsId=navigator.geolocation.watchPosition(pos=>{
      gpsFix={lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy,stamp:Date.now()};
      updateGPS();checkArrival();
    },err=>{
      toast(err.code===1?'Permita o acesso à localização do dispositivo.':'GPS temporariamente indisponível.');stopGPS();
    },{enableHighAccuracy:true,maximumAge:2000,timeout:15000});
    }catch(e){toast('GPS não pôde ser ativado.');return;}
    ui.gps.setAttribute('aria-pressed','true');ui.gps.textContent='◎ GPS ativo';
    gpsPulseTimer=setInterval(updateGPS,3000);
  }
  function stopGPS(){if(gpsId!==null){navigator.geolocation.clearWatch(gpsId);gpsId=null;}clearInterval(gpsPulseTimer);gpsPulseTimer=null;ui.gps.setAttribute('aria-pressed','false');ui.gps.textContent='◎ GPS';gpsFix=null;updateGPS();}
  ui.gps.addEventListener('click',()=>gpsId===null?beginGPS():stopGPS());
  window.addEventListener('pagehide',stopGPS);

  function renderActions(){
    const valid=planValid(), pending=stops.filter(s=>!s.concluida).length;
    ui.start.disabled=!valid||started||working||pending===0;
    ui.optimize.disabled=working||pending===0;
    ui.toMap.classList.toggle('hidden',!valid);
    ui.actionHint.textContent=working?'Calculando a melhor sequência disponível...':!stops.length?'Adicione endereços para preparar sua rota.':!valid?'Endereços cadastrados. Clique em Otimizar rota.':started?'Rota iniciada. Acompanhe o mapa e marque cada entrega.':`Rota pronta: ${fmtNumber(plan.km)} km · ${Math.ceil(plan.mins)} min`;
  }
  function render(){
    const total=stops.length,done=stops.filter(p=>p.concluida).length,pending=total-done;
    ui.navCount.textContent=String(total);ui.count.textContent=`${total} ${total===1?'parada':'paradas'}`;
    ui.listDetail.textContent=`${pending} pendente(s) · ${done} concluída(s)`;
    ui.topProgress.textContent=started?`${done} de ${total} entregues`:planValid()?'Rota pronta para iniciar':`${total} endereços cadastrados`;
    ui.statTotal.textContent=String(total);ui.statPending.textContent=String(pending);ui.statDone.textContent=String(done);
    const percent=total?Math.round(done/total*100):0;ui.statPercent.textContent=`${percent}%`;ui.progressBar.style.width=`${percent}%`;
    ui.summaryRouteTitle.textContent=planValid()?(started?'Rota em andamento':'Rota pronta'):'Rota não otimizada';
    ui.summaryRouteDescription.textContent=planValid()?`${fmtNumber(plan.km)} km · ${Math.ceil(plan.mins)} min (estimativa)`:'Adicione endereços e clique em Otimizar rota.';
    renderActions();renderList();renderMapInfo();updateMapSources();
    if (focusedStopId&&!stops.some(p=>p.id===focusedStopId))closeCard();
  }
  // Test hooks for local automated verification of geometry, legacy migration, and scheduling.
  Object.defineProperty(window,'__rfDiagnostics',{value:Object.freeze({parsed,meters,makePointData,routeData,fingerprint,stops:()=>stops,planValid})});
  save();render();
})();
