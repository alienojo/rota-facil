(() => {
  'use strict';

  // RotaFácil V9 — HTML/CSS/JS puro. Sem cadastros ou chaves exigidas do motorista.
  // Photon oferece busca conforme digita; ViaCEP complementa rua, bairro e CEP.
  // Para escala comercial, hospede um serviço de geocodificação com SLA/proxy próprio.
  const CFG = Object.freeze({
    photon: 'https://photon.komoot.io', viaCep: 'https://viacep.com.br/ws',
    osrm: 'https://router.project-osrm.org',
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
    debounceMs: 480, timeoutMs: 9000, maxStopsForRoadMatrix: 23,
    defaultOrigin: { endereco: 'Centro de São José dos Campos, SP', lat: -23.1794, lon: -45.8869, personalizado: false }
  });
  const ID = id => document.getElementById(id);
  const ui = {
    input: ID('address-input'), listbox: ID('address-options'), searchLoading: ID('search-loading'),
    form: ID('form-add'), add: ID('btn-adicionar'), help: ID('address-message'), cancelEdit: ID('btn-cancel-edit'),
    city: ID('city-input'), state: ID('state-input'),
    optimize: ID('btn-otimizar'), start: ID('btn-iniciar'), heroNotice: ID('hero-notice'),
    heroCount: ID('hero-qtd'), heroKm: ID('hero-km'), heroMin: ID('hero-min'),
    map: ID('map'), mapPlaceholder: ID('map-placeholder'), mapStatus: ID('map-status'), mapBadge: ID('map-badge'),
    gps: ID('btn-gps'), fit: ID('btn-enquadrar'), gpsMessage: ID('gps-message'),
    originInput: ID('origin-input'), originBtn: ID('btn-definir-origem'), originGPS: ID('btn-origem-gps'),
    originLabel: ID('origin-label'), originStatus: ID('origin-status'),
    list: ID('stops-list'), subtitle: ID('list-subtitle'), count: ID('count-badge'),
    clean: ID('btn-limpar-feitas'), reset: ID('btn-apagar-tudo'),
    total: ID('stat-total'), pending: ID('stat-pendentes'), done: ID('stat-concluidas'),
    percent: ID('stat-percent'), progressBar: ID('progress-bar'),
    next: ID('next-stop'), nextNumber: ID('next-number'), nextAddress: ID('next-address'),
    nextProgress: ID('next-progress'), nextNavigate: ID('next-navigate'), nextDone: ID('next-done'),
    arrived: ID('arrival-note'), toast: ID('toast')
  };
  const missing = Object.entries(ui).filter(([,element]) => !element).map(([key]) => key);
  if (missing.length) { console.error('RotaFácil: elementos não encontrados:', missing); return; }

  const STORE = { stops: 'rotafacil_paradas', origin: 'rotafacil_origem', started: 'rotafacil_iniciada', route: 'rotafacil_v9_rota', searchArea: 'rotafacil_v9_area' };
  const getJSON = (key, fallback) => { try { const str = localStorage.getItem(key); return str === null ? fallback : JSON.parse(str); } catch { return fallback; } };
  function validPoint(point) {
    const lat = Number(point?.lat), lon = Number(point?.lon);
    return point && point.lat !== '' && point.lon !== '' && point.lat != null && point.lon != null &&
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }
  function cleanedStop(item) {
    if (!validPoint(item) || typeof item.endereco !== 'string') return null;
    return {
      id: String(item.id ?? `${Date.now()}-${Math.random()}`), endereco: item.endereco,
      lat: Number(item.lat), lon: Number(item.lon), concluida: Boolean(item.concluida),
      precision: item.precision || item.precisao || 'aproximada',
      city: String(item.city || item.campos?.cidade || ''), uf: String(item.uf || item.campos?.uf || 'SP'),
      number: String(item.number || item.campos?.numero || ''),
      urgent: Boolean(item.urgent || item.urgente),
      notes: String(item.notes || item.notas || '').slice(0, 200)
    };
  }
  let stops = (Array.isArray(getJSON(STORE.stops, [])) ? getJSON(STORE.stops, []) : []).map(cleanedStop).filter(Boolean);
  let origin = getJSON(STORE.origin, { ...CFG.defaultOrigin });
  if (!validPoint(origin)) origin = { ...CFG.defaultOrigin };
  origin = { ...origin, lat: Number(origin.lat), lon: Number(origin.lon) };
  const savedArea = getJSON(STORE.searchArea, { city: 'São José dos Campos', uf: 'SP' });
  ui.city.value = String(savedArea?.city || 'São José dos Campos');
  ui.state.value = String(savedArea?.uf || 'SP');
  let planned = getJSON(STORE.route, null);
  let started = Boolean(getJSON(STORE.started, false));
  let editingId = null;
  let routeRevision = 0;
  let optimizing = false;
  let selected = null;
  let highlighted = -1;
  let currentSuggestions = [];
  let searchSeq = 0;
  let searchController = null;
  let searchTimer = null;
  let toastTimer = null;
  const searchCache = new Map();
  let lastPhotonTime = 0;
  let photonQueue = Promise.resolve();
  let map = null, mapReady = false, gpsMarker = null, gpsAccuracyMarker = null, markers = [];
  let gpsWatchId = null, gpsVisualTimer = null, gpsFix = null, activeArrivalId = null;

  function signature() { return JSON.stringify({ origin: [origin.lat, origin.lon], stops: stops.map(p => [p.id, p.lat, p.lon, p.concluida]) }); }
  function routeValid() { return planned && planned.signature === signature() && Array.isArray(planned.order) && planned.order.length > 0; }
  if (!routeValid()) { planned = null; started = false; }
  function save() {
    try {
      localStorage.setItem(STORE.stops, JSON.stringify(stops));
      localStorage.setItem(STORE.origin, JSON.stringify(origin));
      localStorage.setItem(STORE.started, JSON.stringify(started));
      if (planned) localStorage.setItem(STORE.route, JSON.stringify(planned));
      else localStorage.removeItem(STORE.route);
      localStorage.setItem(STORE.searchArea, JSON.stringify({ city: ui.city.value.trim(), uf: ui.state.value.trim().toUpperCase() }));
    } catch (error) { console.error('Não foi possível salvar o projeto:', error); showToast('Não foi possível salvar os dados neste navegador.'); }
  }
  function textStatus(message, error = false) { ui.help.textContent = message; ui.help.classList.toggle('error', error); ui.help.classList.toggle('success', !error && /adicionada|atualizado|selecionado|adicionado/.test(message.toLowerCase())); }
  function showToast(message) { ui.toast.textContent = message; ui.toast.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 3900); }
  function setBusy(button, busy, busyMessage) {
    if (busy) { button.dataset.original = button.textContent; button.textContent = busyMessage; }
    else if (button.dataset.original !== undefined) { button.textContent = button.dataset.original; delete button.dataset.original; }
    button.disabled = busy;
  }
  function invalidate() { routeRevision++; planned = null; started = false; activeArrivalId = null; }
  const radians = deg => deg * Math.PI / 180;
  function meters(a, b) {
    const dLat = radians(b.lat - a.lat), dLon = radians(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizeRoad = s => norm(s).replace(/^(rua|avenida|av|travessa|alameda|estrada|rodovia|praca)\s+/, '');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const locationURL = p => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.lat},${p.lon}`)}&travelmode=driving`;

  // ---- Address parsing. Never interpret 'Rua 7 de Setembro' as house number 7. ----
  function parseAddress(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    const postcodeMatch = raw.match(/\b\d{5}-?\d{3}\b/);
    const postcode = postcodeMatch ? postcodeMatch[0].replace(/\D/g, '') : '';
    const cleaned = postcode ? raw.replace(postcodeMatch[0], ' ').replace(/\s+/g, ' ').trim() : raw;
    let number = '', road = cleaned, extra = '';
    const matches = [...cleaned.matchAll(/\b(?:n[º°o]?\.?\s*)?(\d{1,5}[A-Za-z]?)\b/gi)];
    for (const m of matches.reverse()) {
      const before = cleaned.slice(0, m.index).trim();
      const after = cleaned.slice(m.index + m[0].length).trim();
      const wordBefore = before.split(/[\s,]+/).at(-1)?.toLowerCase();
      if (!before || (['rua','av','avenida','rodovia','travessa'].includes(wordBefore) && /^de\b/i.test(after))) continue;
      if (matches.length === 1 && ['rua','av','avenida','rodovia','travessa'].includes(wordBefore)) continue;
      number = m[1]; road = before.replace(/[\s,º°#-]+$/, '').trim();
      extra = after.replace(/^[\s,;\-]+/, '').trim();
      break;
    }
    road = road.replace(/^\s*(?:n[º°o]?\.?\s*)?$/, '').trim();
    return { road: road || cleaned, number, extra, postcode, raw };
  }
  // Parsing fixture exposed for automated checks without exposing implementation to page UI.
  window.__rotafacilTest = Object.freeze({ parseAddress });

  async function getJSONRemote(url, { signal, timeout = CFG.timeoutMs } = {}) {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
  }
  // One Photon request at a time, with a modest interval so typing doesn't flood the demo API.
  function photonJSON(url, signal) {
    const job = async () => {
      if (signal?.aborted) throw new DOMException('Cancelada', 'AbortError');
      const cooldown = Math.max(0, 1000 - (Date.now() - lastPhotonTime));
      if (cooldown) await wait(cooldown);
      if (signal?.aborted) throw new DOMException('Cancelada', 'AbortError');
      lastPhotonTime = Date.now();
      return getJSONRemote(url, { signal });
    };
    const running = photonQueue.then(job, job);
    photonQueue = running.catch(() => {});
    return running;
  }
  function area() { return { city: ui.city.value.trim() || 'São José dos Campos', uf: ui.state.value.trim().toUpperCase() || 'SP' }; }
  function featureToCandidate(feature) {
    if (!feature?.geometry?.coordinates || !Array.isArray(feature.geometry.coordinates)) return null;
    const [lon, lat] = feature.geometry.coordinates.map(Number);
    if (!validPoint({lat,lon})) return null;
    const p = feature.properties || {};
    const country = String(p.countrycode || '').toLowerCase();
    if (country && country !== 'br') return null;
    const road = p.street || p.name || '';
    const city = p.city || p.town || p.locality || p.county || '';
    if (!road) return null;
    return { road: String(road), district: String(p.district || p.suburb || p.neighbourhood || p.city_district || ''),
      city: String(city), uf: String(p.state || ''), postcode: String(p.postcode || ''),
      house: String(p.housenumber || ''), lat, lon, source: 'photon' };
  }
  function viacepToCandidate(item) {
    if (!item || !item.logradouro || !item.localidade) return null;
    return { road: String(item.logradouro), district: String(item.bairro || ''), city: String(item.localidade),
      uf: String(item.uf || ''), postcode: String(item.cep || ''), house: '', lat: null, lon: null, source: 'viacep' };
  }
  function score(candidate, query, userArea) {
    const street = normalizeRoad(candidate.road), typed = normalizeRoad(query.road);
    let value = 0;
    if (street === typed) value += 160;
    else if (street.startsWith(typed)) value += 90;
    else if (street.includes(typed)) value += 42;
    else if (typed.includes(street) && street.length >= 5) value += 25;
    if (norm(candidate.city) === norm(userArea.city)) value += 55;
    if (norm(candidate.district) && norm(query.extra).includes(norm(candidate.district))) value += 12;
    if (candidate.source === 'viacep') value += 12;
    if (candidate.lat != null) value += 8;
    return value;
  }
  function formatCandidate(candidate, query, userArea) {
    const number = query.number || candidate.house;
    const street = `${candidate.road}${number ? `, ${number}` : ''}`;
    const district = candidate.district ? `${candidate.district} · ` : '';
    const city = candidate.city || userArea.city;
    const uf = /^[A-Z]{2}$/.test(candidate.uf) ? candidate.uf : userArea.uf;
    return { title: street, sub: `${district}${city}/${uf}${candidate.postcode ? ` · CEP ${candidate.postcode}` : ''}`,
      address: `${street}${candidate.district ? ` — ${candidate.district}` : ''} — ${city}/${uf}`,
      number, uf, city };
  }
  function mergeCandidates(a, b) {
    const merged = new Map();
    for (const c of [...a, ...b]) {
      const key = [norm(c.road), norm(c.district), norm(c.city)].join('|');
      const prev = merged.get(key);
      if (!prev) merged.set(key, c);
      else merged.set(key, { ...prev, ...c,
        // ViaCEP is preferred for bairro and CEP, Photon for coordinates.
        district: prev.source === 'viacep' ? prev.district || c.district : c.source === 'viacep' ? c.district || prev.district : prev.district || c.district,
        postcode: prev.postcode || c.postcode,
        lat: prev.lat ?? c.lat, lon: prev.lon ?? c.lon,
        house: prev.house || c.house,
        source: prev.lat != null || c.lat != null ? 'combined' : 'viacep' });
    }
    return [...merged.values()];
  }

  function hideSuggestions() {
    ui.listbox.classList.add('hidden');
    ui.input.setAttribute('aria-expanded', 'false');
    ui.input.setAttribute('aria-activedescendant', '');
    highlighted = -1;
  }
  function renderSuggestions(query, candidates, userArea, waiting = false) {
    const ordered = candidates.map(c => ({ c, rank: score(c, query, userArea) })).sort((a,b) => b.rank - a.rank).slice(0, 8).map(x=>x.c);
    currentSuggestions = ordered;
    highlighted = -1;
    ui.listbox.replaceChildren();
    if (!ordered.length) {
      const box = document.createElement('div'); box.className = 'suggestion-empty';
      box.textContent = waiting ? 'Buscando endereços e bairros...' : 'Nenhuma sugestão encontrada. Tente incluir o bairro ou selecionar outra cidade.';
      ui.listbox.appendChild(box);
    }
    ordered.forEach((candidate, index) => {
      const info = formatCandidate(candidate, query, userArea);
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'suggestion'; button.id = `suggestion-${index}`;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
      const icon = document.createElement('span'); icon.className = 'pin'; icon.textContent = '⌖';
      const body = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = info.title;
      const sub = document.createElement('small'); sub.textContent = info.sub;
      body.append(title, sub);
      if (query.number && !(candidate.house && norm(candidate.house) === norm(query.number))) {
        const warn = document.createElement('em'); warn.textContent = 'Número informado por você · posição do imóvel não confirmada';
        body.appendChild(warn);
      }
      button.append(icon, body);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => chooseSuggestion(candidate, query, userArea));
      ui.listbox.appendChild(button);
    });
    ui.listbox.classList.remove('hidden');
    ui.input.setAttribute('aria-expanded', 'true');
  }
  function chooseSuggestion(candidate, query, userArea) {
    // Selecting a result cancels in-flight autocomplete: late responses must not reopen the menu.
    searchSeq++;
    clearTimeout(searchTimer);
    searchController?.abort();
    ui.searchLoading.classList.add('hidden');
    const info = formatCandidate(candidate, query, userArea);
    selected = { ...candidate, ...info, typedNumber: query.number, precision: candidate.house && norm(candidate.house) === norm(query.number) && query.number ? 'exata' : 'aproximada' };
    ui.input.value = info.address;
    hideSuggestions();
    textStatus(query.number ? 'Endereço selecionado. Clique em Adicionar entrega.' : 'Endereço selecionado. Você já pode adicionar.');
    ui.add.focus();
  }
  async function getPhotonCandidates(query, userArea, signal) {
    const requested = `${query.road}, ${userArea.city}, ${userArea.uf}, Brasil`;
    const url = `${CFG.photon}/api/?q=${encodeURIComponent(requested)}&lat=${origin.lat}&lon=${origin.lon}&limit=12&lang=pt`;
    const data = await photonJSON(url, signal);
    return (Array.isArray(data.features) ? data.features : []).map(featureToCandidate).filter(Boolean);
  }
  async function getViaCepCandidates(query, userArea, signal) {
    const road = query.road.replace(/^(rua|avenida|av\.?|travessa|alameda|praca|praça)\s+/i,'').trim();
    if (road.length < 3 || userArea.city.length < 3 || !/^[A-Z]{2}$/.test(userArea.uf)) return [];
    const url = `${CFG.viaCep}/${encodeURIComponent(userArea.uf)}/${encodeURIComponent(userArea.city)}/${encodeURIComponent(road)}/json/`;
    const data = await getJSONRemote(url, { signal, timeout: 7000 });
    return (Array.isArray(data) ? data : []).map(viacepToCandidate).filter(Boolean);
  }
  async function runSearch() {
    const query = parseAddress(ui.input.value);
    const userArea = area();
    if (query.road.length < 3) { hideSuggestions(); ui.searchLoading.classList.add('hidden'); return; }
    const seq = ++searchSeq;
    searchController?.abort();
    const controller = new AbortController(); searchController = controller;
    const cacheKey = `${norm(query.road)}|${norm(userArea.city)}|${userArea.uf}`;
    if (searchCache.has(cacheKey)) {
      renderSuggestions(query, searchCache.get(cacheKey), userArea);
      return;
    }
    ui.searchLoading.classList.remove('hidden');
    renderSuggestions(query, [], userArea, true);
    let collected = [];
    let success = 0;
    const receive = candidates => {
      if (seq !== searchSeq || controller.signal.aborted) return;
      success++;
      collected = mergeCandidates(collected, candidates);
      renderSuggestions(parseAddress(ui.input.value), collected, userArea, true);
    };
    const requests = [getPhotonCandidates(query, userArea, controller.signal), getViaCepCandidates(query, userArea, controller.signal)];
    await Promise.allSettled(requests.map(p => p.then(receive)));
    if (seq !== searchSeq || controller.signal.aborted) return;
    searchCache.set(cacheKey, collected);
    if (searchCache.size > 70) searchCache.delete(searchCache.keys().next().value);
    ui.searchLoading.classList.add('hidden');
    renderSuggestions(parseAddress(ui.input.value), collected, userArea);
    if (!collected.length && success === 0) textStatus('Os serviços de busca não responderam. Verifique a conexão e tente novamente.', true);
    else if (!collected.length) textStatus('Não encontramos a rua. Tente acrescentar bairro ou mudar a cidade.', true);
  }
  function inputChange() {
    clearTimeout(searchTimer);
    selected = null;
    searchSeq++;
    searchController?.abort();
    ui.searchLoading.classList.add('hidden');
    const query = parseAddress(ui.input.value);
    if (query.road.length < 3) { hideSuggestions(); textStatus('Digite pelo menos 3 letras da rua.'); return; }
    // Invalidate previous results, but respond instantly from cache when only the house number changes.
    const userArea = area();
    const cacheKey = `${norm(query.road)}|${norm(userArea.city)}|${userArea.uf}`;
    if (searchCache.has(cacheKey)) renderSuggestions(query, searchCache.get(cacheKey), userArea);
    else { hideSuggestions(); ui.listbox.replaceChildren(); }
    textStatus('Buscando sugestões de ruas e bairros...');
    searchTimer = setTimeout(runSearch, CFG.debounceMs);
  }
  ui.input.addEventListener('input', inputChange);
  ui.input.addEventListener('focus', () => {
    if (selected) return;
    const q = parseAddress(ui.input.value), a = area();
    const key = `${norm(q.road)}|${norm(a.city)}|${a.uf}`;
    if (searchCache.has(key)) renderSuggestions(q, searchCache.get(key), a);
  });
  ui.input.addEventListener('keydown', event => {
    if (ui.listbox.classList.contains('hidden') || !currentSuggestions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlighted = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + currentSuggestions.length) % currentSuggestions.length;
      const options = [...ui.listbox.querySelectorAll('[role=option]')];
      options.forEach((option,i) => { option.classList.toggle('active', i === highlighted); option.setAttribute('aria-selected', String(i === highlighted)); });
      ui.input.setAttribute('aria-activedescendant', options[highlighted]?.id || '');
      options[highlighted]?.scrollIntoView({block:'nearest'});
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault(); chooseSuggestion(currentSuggestions[highlighted], parseAddress(ui.input.value), area());
    } else if (event.key === 'Escape') { hideSuggestions(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!ID('address-wrap').contains(event.target)) hideSuggestions();
  });
  for (const input of [ui.city, ui.state]) input.addEventListener('change', () => { selected = null; inputChange(); save(); });

  // ---- Obtain coordinates. Never present an inserted house number as confirmed unless Photon returned it. ----
  async function resolveCoordinates(candidate, userArea, signal) {
    const parsed = parseAddress(candidate.address || ui.input.value);
    const house = candidate.typedNumber || candidate.number || parsed.number;
    const road = candidate.road || parsed.road;
    const city = candidate.city || userArea.city;
    const uf = /^[A-Z]{2}$/.test(candidate.uf || '') ? candidate.uf : userArea.uf;
    const originalPoint = validPoint(candidate) ? { lat: Number(candidate.lat), lon: Number(candidate.lon) } : null;
    if (candidate.precision === 'exata' && originalPoint) return { ...originalPoint, precision: 'exata' };
    // Structured Photon search is the only extra call; when the house is not mapped, preserve road position.
    if (house) {
      try {
        const url = `${CFG.photon}/structured?street=${encodeURIComponent(road)}&housenumber=${encodeURIComponent(house)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(uf)}&countrycode=BR&limit=5`;
        const res = await photonJSON(url, signal);
        for (const feature of res.features || []) {
          const props = feature.properties || {};
          const found = featureToCandidate(feature);
          if (found && norm(props.housenumber) === norm(house) && normalizeRoad(found.road) === normalizeRoad(road) && (!found.city || norm(found.city) === norm(city))) {
            return { lat: found.lat, lon: found.lon, precision: 'exata' };
          }
        }
      } catch (error) { if (signal?.aborted) throw error; console.warn('Consulta do número indisponível:', error); }
    }
    if (originalPoint) return { ...originalPoint, precision: 'aproximada' };
    const q = { road, number: house, extra: candidate.district || '', raw: road };
    const matches = await getPhotonCandidates(q, { city, uf }, signal);
    const suitable = matches.sort((a,b) => score(b,q,{city,uf})-score(a,q,{city,uf})).find(c =>
      normalizeRoad(c.road) === normalizeRoad(road) && (!c.city || norm(c.city) === norm(city)));
    if (!suitable) throw new Error('Encontrei a rua no cadastro, mas não consegui posicioná-la no mapa. Tente selecionar outra sugestão.');
    return { lat: suitable.lat, lon: suitable.lon, precision: 'aproximada' };
  }
  function stopFromCandidate(c, coordinate, fallback) {
    const addr = c.address || c.raw || fallback;
    return { endereco: addr, lat: coordinate.lat, lon: coordinate.lon,
      number: c.typedNumber || c.number || parseAddress(addr).number || '',
      city: c.city || area().city, uf: c.uf || area().uf, precision: coordinate.precision };
  }
  ui.form.addEventListener('submit', async event => {
    event.preventDefault();
    if (ui.add.disabled) return;
    const typed = ui.input.value.trim();
    if (typed.length < 3) { textStatus('Digite um endereço antes de adicionar.', true); ui.input.focus(); return; }
    // Avoid accidental double click while the coordinate search is running.
    const addressChosen = selected && selected.address === typed ? { ...selected } : null;
    const userArea = area();
    const parsed = parseAddress(typed);
    const candidate = addressChosen || { road: parsed.road, typedNumber: parsed.number, number: parsed.number,
      address: typed, city: userArea.city, uf: userArea.uf, district: parsed.extra, lat: null, lon: null };
    const token = routeRevision;
    const ctrl = new AbortController();
    setBusy(ui.add, true, 'Localizando...');
    hideSuggestions();
    textStatus('Localizando a rua no mapa...');
    try {
      const coord = await resolveCoordinates(candidate, userArea, ctrl.signal);
      if (ui.input.value.trim() !== typed) throw new Error('O endereço foi alterado. Confirme novamente antes de salvar.');
      if (token !== routeRevision) throw new Error('A rota mudou enquanto você adicionava o endereço. Tente novamente.');
      const data = stopFromCandidate(candidate, coord, typed);
      if (editingId) {
        const i = stops.findIndex(p => p.id === editingId);
        if (i < 0) throw new Error('Essa entrega não está mais na lista.');
        stops[i] = { ...stops[i], ...data };
      } else {
        stops.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, ...data, concluida: false });
      }
      const wasEditing = Boolean(editingId);
      editingId = null;
      ui.input.value = ''; selected = null;
      ui.add.textContent = '＋ Adicionar entrega';
      ui.cancelEdit.classList.add('hidden');
      searchSeq++; searchController?.abort();
      invalidate(); drawAll(); save();
      textStatus(wasEditing ? 'Endereço atualizado na lista.' : 'Entrega adicionada à lista.');
      if (coord.precision !== 'exata') showToast('Entrega salva com posição aproximada da rua.');
    } catch (error) {
      textStatus(error.message || 'Não conseguimos localizar este endereço. Tente uma sugestão diferente.', true);
    } finally { setBusy(ui.add, false, ''); if (!editingId) ui.add.textContent = '＋ Adicionar entrega'; }
  });

  ui.cancelEdit.addEventListener('click', () => {
    editingId = null; selected = null; ui.input.value = '';
    ui.add.textContent = '＋ Adicionar entrega';
    ui.cancelEdit.classList.add('hidden');
    searchSeq++; searchController?.abort(); clearTimeout(searchTimer); hideSuggestions();
    textStatus('Digite o nome da rua e o número para começar.');
  });

  // ---- Map. Map errors must never stop address entry. ----
  function initMap() {
    if (!window.maplibregl) { ui.mapPlaceholder.classList.remove('hidden'); ui.mapStatus.textContent = 'Mapa temporariamente indisponível.'; return; }
    try {
      map = new maplibregl.Map({ container: ui.map, style: CFG.mapStyle, center: [origin.lon, origin.lat], zoom: 12.8, attributionControl: true });
      map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'bottom-right');
      map.on('load', () => {
        mapReady = true;
        map.addSource('route-line', { type:'geojson', data: {type:'FeatureCollection', features:[]} });
        map.addLayer({ id:'route-stroke', source:'route-line', type:'line', layout:{'line-cap':'round','line-join':'round'}, paint:{'line-color':'#278e69','line-width':5,'line-opacity':.9} });
        drawMap();
      });
      map.on('error', event => {
        console.warn('Mapa:', event.error);
        if (!mapReady) {
          ui.mapStatus.textContent = 'Mapa indisponível no momento. O cadastro continua funcionando.';
          ui.mapPlaceholder.classList.remove('hidden');
        }
      });
    } catch (error) { console.warn('Mapa indisponível:', error); ui.mapPlaceholder.classList.remove('hidden'); }
  }
  function createMarker(label, type, lng, lat, popupText) {
    const element = document.createElement('div');
    element.className = `map-pin ${type}`;
    element.textContent = label;
    const popup = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = popupText;
    popup.appendChild(title);
    const marker = new maplibregl.Marker({ element }).setLngLat([lng,lat]).setPopup(new maplibregl.Popup({offset:17}).setDOMContent(popup)).addTo(map);
    markers.push(marker);
  }
  function fitMap() {
    if (!mapReady) return;
    const points = [[origin.lon,origin.lat],...stops.map(p=>[p.lon,p.lat])];
    if (!points.length) return;
    if (points.length === 1) { map.easeTo({center:points[0], zoom:14}); return; }
    const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
    points.slice(1).forEach(p=>bounds.extend(p));
    map.fitBounds(bounds, {padding:45,maxZoom:15,duration:450});
  }
  function drawMap() {
    if (!mapReady) return;
    markers.forEach(m=>m.remove()); markers=[];
    createMarker('⌂','origin',origin.lon,origin.lat,`Origem: ${origin.endereco}`);
    const next = started ? stops.find(p=>!p.concluida) : null;
    stops.forEach((p,i)=>createMarker(String(i+1),p.concluida ? 'done' : next?.id === p.id ? 'next' : '',p.lon,p.lat,p.endereco));
    const line = routeValid() ? planned.geometry : null;
    const feature = line && line.length > 1 ? { type:'Feature',properties:{},geometry:{type:'LineString',coordinates:line} } : null;
    map.getSource('route-line')?.setData({type:'FeatureCollection',features:feature?[feature]:[]});
    map.setPaintProperty('route-stroke','line-dasharray',planned?.approximate?[1.4,1.4]:[1,0]);
    if (gpsFix) displayGps();
  }
  ui.fit.addEventListener('click', fitMap);

  // ---- GPS position. Geofence arrival is informational; delivery is never marked automatically. ----
  function displayGps() {
    if (!gpsFix || !mapReady) return;
    if (!gpsMarker) {
      const node = document.createElement('div'); node.className = 'gps-marker';
      gpsMarker = new maplibregl.Marker({element:node}).setLngLat([gpsFix.lon,gpsFix.lat]).addTo(map);
    } else gpsMarker.setLngLat([gpsFix.lon,gpsFix.lat]);
    ui.gpsMessage.textContent = `◎ GPS ativo · precisão aproximada ±${Math.round(gpsFix.accuracy)} m`;
    const target = stops.find(p=>!p.concluida);
    if (started && target && target.precision === 'exata' && gpsFix.accuracy <= 10 && meters(gpsFix,target) <= 10) {
      if (activeArrivalId !== target.id) {
        activeArrivalId = target.id;
        ui.arrived.textContent = 'Você chegou perto do destino. Confirme a entrega ao finalizar.';
        ui.arrived.classList.remove('hidden');
        showToast('Destino próximo: confira o local de entrega.');
      }
    }
  }
  function stopGPS() {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null; clearInterval(gpsVisualTimer); gpsVisualTimer = null;
    gpsMarker?.remove(); gpsMarker = null; gpsFix = null;
    ui.gps.textContent = '◎ GPS ao vivo'; ui.gps.setAttribute('aria-pressed','false'); ui.gps.classList.remove('active');
    ui.gpsMessage.textContent = '● Origem    ● Entregas    ● GPS';
  }
  ui.gps.addEventListener('click', () => {
    if (gpsWatchId !== null) { stopGPS(); return; }
    if (!navigator.geolocation) { showToast('GPS não disponível neste navegador.'); return; }
    if (!window.isSecureContext) { showToast('Para usar GPS, abra por HTTPS ou localhost.'); return; }
    ui.gps.textContent = '◎ Ligando GPS...';
    gpsWatchId = navigator.geolocation.watchPosition(position => {
      gpsFix = {lat:position.coords.latitude,lon:position.coords.longitude,accuracy:position.coords.accuracy};
      displayGps();
    }, error => {
      showToast(error.code===1?'Autorize a localização no navegador.':'Não conseguimos obter seu GPS.');
      stopGPS();
    }, {enableHighAccuracy:true,maximumAge:5000,timeout:17000});
    ui.gps.textContent='● GPS ligado'; ui.gps.classList.add('active'); ui.gps.setAttribute('aria-pressed','true');
    gpsVisualTimer = setInterval(displayGps, 5000);
  });
  window.addEventListener('pagehide', stopGPS);

  // ---- Origin ----
  ui.originInput.value = origin.personalizado ? origin.endereco : '';
  ui.originLabel.textContent = origin.personalizado ? origin.endereco : 'São José dos Campos, SP';
  ui.originBtn.addEventListener('click', async () => {
    const typed = ui.originInput.value.trim();
    if (!typed) { ui.originStatus.textContent='Digite uma origem para continuar.'; return; }
    setBusy(ui.originBtn,true,'Buscando...');
    try {
      const query = parseAddress(typed), a = area();
      const hits = await getPhotonCandidates(query,a);
      const selectedOrigin = hits.sort((x,y)=>score(y,query,a)-score(x,query,a))[0];
      if (!selectedOrigin) throw new Error('Não foi possível localizar esta origem.');
      origin = { endereco:typed,lat:selectedOrigin.lat,lon:selectedOrigin.lon,personalizado:true };
      ui.originLabel.textContent = typed;
      ui.originStatus.textContent = 'Ponto de partida atualizado.';
      invalidate(); drawAll(); save(); fitMap();
    } catch (error) { ui.originStatus.textContent = error.message || 'Não foi possível localizar a origem.'; }
    finally { setBusy(ui.originBtn,false,''); }
  });
  ui.originGPS.addEventListener('click', () => {
    if (!navigator.geolocation || !window.isSecureContext) { ui.originStatus.textContent='GPS requer HTTPS ou localhost.';return; }
    navigator.geolocation.getCurrentPosition(position => {
      origin={ endereco:'Minha localização atual',lat:position.coords.latitude,lon:position.coords.longitude,personalizado:true };
      ui.originInput.value=origin.endereco;ui.originLabel.textContent='Localização atual';
      ui.originStatus.textContent='Origem definida pelo GPS.';invalidate();drawAll();save();fitMap();
    },()=>{ui.originStatus.textContent='GPS indisponível. Verifique a permissão.';},{enableHighAccuracy:true,timeout:15000});
  });

  // ---- Route optimizer: road durations → nearest-neighbor + 2-opt; geographic fallback. ----
  function greedy(points, matrix) {
    const remaining = points.map((_,i)=>i+1);const result=[];let current=0;
    while (remaining.length) {
      let pick=0, best=Infinity;
      remaining.forEach((id,i)=>{ const value=matrix[current]?.[id];if(Number.isFinite(value)&&value<best){best=value;pick=i;} });
      current=remaining.splice(pick,1)[0];result.push(current);
    }
    return result;
  }
  function routeCost(indices, matrix) {
    let total=0, prev=0;
    for (const idx of indices) { const val=matrix[prev]?.[idx];total+=Number.isFinite(val)?val:1e10;prev=idx; }
    return total;
  }
  function refine2Opt(initial, matrix) {
    let best=[...initial];let bestCost=routeCost(best,matrix), improved=true, passes=0;
    while(improved && passes++<6){improved=false;
      for(let i=0;i<best.length-1;i++) for(let j=i+1;j<best.length;j++) {
        const test=[...best.slice(0,i),...best.slice(i,j+1).reverse(),...best.slice(j+1)];
        const cost=routeCost(test,matrix);
        if(cost+0.000001<bestCost){best=test;bestCost=cost;improved=true;}
      }
    }
    return best;
  }
  function distanceMatrix(points) {
    return points.map(a=>points.map(b=>meters(a,b)));
  }
  async function getRoadMatrix(points) {
    const coords=points.map(p=>`${p.lon},${p.lat}`).join(';');
    const url=`${CFG.osrm}/table/v1/driving/${coords}?annotations=duration`;
    const data=await getJSONRemote(url,{timeout:16000});
    if(data.code!=='Ok'||!Array.isArray(data.durations))throw new Error('Matriz de ruas indisponível');
    return data.durations;
  }
  async function getRoadPolyline(points) {
    const coords=points.map(p=>`${p.lon},${p.lat}`).join(';');
    const url=`${CFG.osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const data=await getJSONRemote(url,{timeout:18000});
    if(data.code!=='Ok'||!data.routes?.[0]?.geometry?.coordinates)throw new Error('Percurso indisponível');
    return data.routes[0];
  }
  function orderPending(ids) {
    const order=new Map(ids.map((p,i)=>[p.id,i]));
    const complete=stops.filter(p=>p.concluida);
    const pending=stops.filter(p=>!p.concluida).sort((a,b)=>order.get(a.id)-order.get(b.id));
    stops=[...complete,...pending];
  }
  ui.optimize.addEventListener('click', async () => {
    if(optimizing) return;
    const pending=stops.filter(p=>!p.concluida);
    if(!pending.length){showToast('Adicione pelo menos uma entrega pendente.');return;}
    const snapshot=routeRevision;
    optimizing=true;setBusy(ui.optimize,true,'Otimizando...');ui.start.disabled=true;
    ui.heroNotice.textContent='Calculando a sequência das entregas...';
    try{
      const points=[origin,...pending];
      let matrix, matrixApproximate=false;
      try { matrix=points.length-1<=CFG.maxStopsForRoadMatrix ? await getRoadMatrix(points) : distanceMatrix(points);matrixApproximate=points.length-1>CFG.maxStopsForRoadMatrix; }
      catch (error){console.warn('Distâncias por ruas indisponíveis:',error);matrix=distanceMatrix(points);matrixApproximate=true;}
      if(snapshot!==routeRevision) return;
      const best=refine2Opt(greedy(pending,matrix),matrix);
      const ordered=best.map(i=>pending[i-1]);
      let route=null;
      if(ordered.length<=CFG.maxStopsForRoadMatrix) {
        try{route=await getRoadPolyline([origin,...ordered]);}catch(error){console.warn('Traçado por ruas indisponível:',error);}
      }
      if(snapshot!==routeRevision) return;
      orderPending(ordered);
      const pointsOrdered=[origin,...ordered];
      const approxKm=pointsOrdered.slice(1).reduce((sum,p,i)=>sum+meters(pointsOrdered[i],p),0)*1.25/1000;
      const km=route ? route.distance/1000 : approxKm;
      const mins=route ? Math.ceil(route.duration/60) : Math.ceil(approxKm/28*60);
      const geometry=route ? route.geometry.coordinates : pointsOrdered.map(p=>[p.lon,p.lat]);
      planned={signature:signature(),order:ordered.map(p=>p.id),km,mins,geometry,
        approximate:matrixApproximate||!route, roadLine:Boolean(route)};
      started=false;save();drawAll();fitMap();
      showToast(route?'Rota calculada. Agora você pode começar as entregas.':'Ordem calculada, mas o percurso está aproximado.');
    } catch(error) { ui.heroNotice.textContent='Não foi possível otimizar agora. Tente novamente.';showToast(error.message||'Erro ao otimizar.'); }
    finally{optimizing=false;setBusy(ui.optimize,false,'');drawAll();}
  });
  ui.start.addEventListener('click',()=>{
    if(!routeValid()){showToast('Otimize a rota antes de começar.');return;}
    started=true;activeArrivalId=null;save();drawAll();showToast('Rota iniciada. Boa entrega!');
  });

  // ---- Delivery list and progress ----
  function el(tag, className, text) { const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node; }
  function buildButton(label, action, className='', title='') {
    const b=el('button',className,label);b.type='button';if(title)b.title=title;b.addEventListener('click',action);return b;
  }
  function renderStops() {
    ui.list.replaceChildren();
    if(!stops.length)ui.list.append(el('div','empty','Nenhuma entrega cadastrada. Digite uma rua acima para começar.'));
    const next=started?stops.find(p=>!p.concluida):null;
    stops.forEach((stop,index)=>{
      const card=el('article',`stop${stop.concluida?' completed':''}${next?.id===stop.id?' primary':''}`);
      const num=el('span','stop-index',String(index+1));
      const info=el('div','stop-info');
      info.append(el('strong',stop.concluida?'done':'',stop.endereco));
      info.append(el('small','',`${stop.concluida?'Concluída':'Pendente'} · ${stop.precision==='exata'?'Localização do imóvel identificada':'Localização aproximada'}`));
      const actions=el('div','stop-actions');
      const link=el('a','', '↗ Navegar');link.href=locationURL(stop);link.target='_blank';link.rel='noopener noreferrer';
      const mark=buildButton(stop.concluida?'↶ Desfazer':'✓ Entregue',()=>{
        const hadPlan = routeValid();
        stop.concluida=!stop.concluida;
        if(!started || !hadPlan) invalidate();
        else { planned.signature=signature(); activeArrivalId=null; }
        save();drawAll();
      },'done-btn');
      const edit=buildButton('✎ Editar',()=>{
        editingId=stop.id;selected=null;ui.input.value=stop.endereco;ui.add.textContent='✓ Salvar edição';ui.cancelEdit.classList.remove('hidden');
        ui.input.focus();ui.input.scrollIntoView({behavior:'smooth',block:'center'});
        textStatus('Edite o endereço, escolha a sugestão correta e clique em Salvar edição.');
        inputChange();
      });
      const remove=buildButton('✕',()=>{
        if(!confirm(`Remover a entrega: ${stop.endereco}?`))return;
        stops=stops.filter(x=>x.id!==stop.id);if(editingId===stop.id)editingId=null;
        invalidate();save();drawAll();
      },'remove','Excluir entrega');
      actions.append(link,mark,edit,remove);
      card.append(num,info,actions);ui.list.appendChild(card);
    });
  }
  function drawStats() {
    const total=stops.length, done=stops.filter(p=>p.concluida).length,pending=total-done;
    ui.heroCount.textContent=String(pending);
    ui.heroKm.textContent=routeValid()?`${planned.km.toFixed(1).replace('.',',')} km`:'—';
    ui.heroMin.textContent=routeValid()?`${planned.mins} min`:'—';
    ui.heroNotice.textContent=routeValid()?(planned.approximate?'Rota pronta · estimativas aproximadas.':'Rota pronta para iniciar.') :total?'Você adicionou endereços. Clique em Otimizar rota quando terminar.':'Adicione suas entregas para começar.';
    ui.optimize.disabled=optimizing||!pending;
    ui.start.disabled=optimizing||!routeValid();
    ui.count.textContent=`${total} ${total===1?'parada':'paradas'}`;
    ui.subtitle.textContent=`${pending} ${pending===1?'pendente':'pendentes'} · ${done} ${done===1?'concluída':'concluídas'}`;
    ui.total.textContent=String(total);ui.pending.textContent=String(pending);ui.done.textContent=String(done);
    const percent=total?Math.round(done/total*100):0;
    ui.percent.textContent=`${percent}%`;ui.progressBar.style.width=`${percent}%`;
    ui.mapBadge.textContent=routeValid()?(started?'Rota em andamento':'Rota otimizada'):'Em preparação';
    ui.mapStatus.textContent=routeValid()?(planned.roadLine?'Percurso traçado pelas ruas.':'Percurso aproximado.'): 'Os pontos aparecem enquanto você cadastra. A linha aparece após otimizar.';
    const target=started?stops.find(p=>!p.concluida):null;
    ui.next.classList.toggle('hidden',!target);
    if(target){ui.nextNumber.textContent=String(stops.indexOf(target)+1);ui.nextAddress.textContent=target.endereco;
      ui.nextNavigate.href=locationURL(target);ui.nextProgress.textContent=`${done} de ${total} concluídas`;
      ui.nextDone.onclick=()=>{
        const hadPlan = routeValid();
        target.concluida=true; if(hadPlan) planned.signature=signature(); else invalidate();
        activeArrivalId=null;ui.arrived.classList.add('hidden');save();drawAll();
      };
    }else ui.arrived.classList.add('hidden');
  }
  function drawAll(){renderStops();drawStats();drawMap();}
  ui.clean.addEventListener('click',()=>{
    const count=stops.filter(p=>p.concluida).length;
    if(!count){showToast('Nenhuma entrega concluída para remover.');return;}
    stops=stops.filter(p=>!p.concluida);invalidate();save();drawAll();
  });
  ui.reset.addEventListener('click',()=>{
    if(!stops.length)return;
    if(!confirm('Apagar todas as entregas e iniciar uma rota nova?'))return;
    stops=[];editingId=null;selected=null;ui.input.value='';invalidate();save();drawAll();showToast('Lista apagada.');
  });

  // ---- Initialize ----
  drawStats();renderStops();initMap();
})();
