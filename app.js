(() => {
  'use strict';

  // RotaFácil V15 — mapa com sequência, rota contínua e cadastro responsivo e cartões flutuantes sobre o mapa.
  // Photon oferece busca conforme digita; ViaCEP complementa rua, bairro e CEP.
  // Para escala comercial, hospede um serviço de geocodificação com SLA/proxy próprio.
  const CFG = Object.freeze({
    photon: 'https://photon.komoot.io', viaCep: 'https://viacep.com.br/ws',
    osrm: 'https://router.project-osrm.org',
    overpass: 'https://overpass-api.de/api/interpreter',
    addressLookupRadius: 2500, addressLookupTimeout: 7500,
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
    debounceMs: 380, timeoutMs: 8000, maxStopsForRoadMatrix: 23, maxAddressChecks: 4,
    defaultOrigin: { endereco: 'Centro de São José dos Campos, SP', lat: -23.1794, lon: -45.8869, personalizado: false }
  });
  const ID = id => document.getElementById(id);
  const ui = {
    input: ID('address-input'), listbox: ID('address-options'), searchLoading: ID('search-loading'),
    scan: ID('btn-scan'), scanLabel: ID('scan-label'), scanFile: ID('scan-file'),
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
    arrived: ID('arrival-note'), toast: ID('toast'),
    tabs: [ID('tab-entregas'), ID('tab-mapa'), ID('tab-resumo')],
    panels: [ID('panel-entregas'), ID('panel-mapa'), ID('panel-resumo')],
    activeTabTitle: ID('active-tab-title'), topbarProgress: ID('topbar-progress'), navCount: ID('nav-count'),
    openMap: ID('btn-open-map'), backDeliveries: ID('btn-back-deliveries'),
    mapFloat: ID('map-float'), mapFloatClose: ID('map-float-close'),
    mapFloatLabel: ID('map-float-label'), mapFloatStatus: ID('map-float-status'),
    mapFloatAddress: ID('map-float-address'), mapFloatDetail: ID('map-float-detail'),
    mapFloatNavigate: ID('map-float-navigate'), mapFloatDone: ID('map-float-done'),
    mapFloatEdit: ID('map-float-edit'), mapFloatChoices: ID('map-float-choices'),
    mapFloatActions: ID('map-float-actions'), mapHint: ID('map-hint'),
    mapRoutePhase: ID('map-route-phase'), mapRouteNote: ID('map-route-note'),
    mapRoutePending: ID('map-route-pending'), mapRouteKm: ID('map-route-km'), mapRouteTime: ID('map-route-time'),
    mapSequence: ID('map-sequence-list'), mapSequenceStatus: ID('map-sequence-status'), mapSequenceHint: ID('map-sequence-hint')
  };
  const missing = Object.entries(ui).flatMap(([key, element]) =>
    Array.isArray(element) ? element.some(item => !item) ? [key] : [] : !element ? [key] : []);
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
      number: String(item.number || item.campos?.numero || parseAddress(item.endereco).number || ''),
      urgent: Boolean(item.urgent || item.urgente),
      notes: String(item.notes || item.notas || '').slice(0, 200),
      road: String(item.road || parseAddress(item.endereco).road || ''), district: String(item.district || ''),
      propertyLat: validPoint({lat:item.propertyLat,lon:item.propertyLon}) ? Number(item.propertyLat) : Number(item.lat),
      propertyLon: validPoint({lat:item.propertyLat,lon:item.propertyLon}) ? Number(item.propertyLon) : Number(item.lon),
      navLat: validPoint({lat:item.navLat,lon:item.navLon}) ? Number(item.navLat) : Number(item.lat),
      navLon: validPoint({lat:item.navLat,lon:item.navLon}) ? Number(item.navLon) : Number(item.lon),
      locationChecked: Boolean(item.locationChecked), accessConfirmed: Boolean(item.accessConfirmed), locationSource: String(item.locationSource || '')
    };
  }
  let stops = (Array.isArray(getJSON(STORE.stops, [])) ? getJSON(STORE.stops, []) : []).map(cleanedStop).filter(Boolean);
  stops.forEach(stop => { if (stop.precision === 'exata' && validPoint({lat:stop.propertyLat,lon:stop.propertyLon})) { stop.lat=stop.propertyLat; stop.lon=stop.propertyLon; } });
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
  let activeTab = 'entregas', mapInitialized = false, focusedStopId = null, focusedGroupKey = null;
  const roadSnapCache = new Map();
  const refineInProgress = new Set();

  function signature() { return JSON.stringify({ origin: [origin.lat, origin.lon], stops: stops.map(p => [p.id, p.lat, p.lon, p.navLat, p.navLon, p.concluida]) }); }
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
  // Ao navegar para uma casa não mapeada, o Google Maps pode resolver o número
  // pelo próprio banco de dados. Não repassar o centro da rua como se fosse a residência.
  const locationURL = p => {
    const dest = p.precision === 'exata'
      ? `${p.navLat ?? p.lat},${p.navLon ?? p.lon}`
      : `${p.road || p.endereco}, ${p.number || ''}, ${p.district || ''}, ${p.city || ''}, ${p.uf || ''}, Brasil`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
  };

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
  window.__rotafacilTest = Object.freeze({ parseAddress, normalizeRoad, meters, getOSMAddressMatches: (...args) => getOSMAddressMatches(...args) });

  async function getJSONRemote(url, { signal, timeout = CFG.timeoutMs } = {}) {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) {
        // O erro técnico fica no console; o motorista recebe mensagem compreensível.
        const source = url.includes('photon.komoot.io') ? 'Photon' : url.includes('viacep.com.br') ? 'ViaCEP' : 'Serviço de rotas';
        console.warn(`RotaFácil: ${source} respondeu HTTP ${response.status}`);
        const error = new Error(`Serviço indisponível (${source}, ${response.status})`);
        error.status = response.status;
        error.service = source;
        throw error;
      }
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
    const road = p.street || ((p.osm_key === 'highway' || p.type === 'street') ? p.name : '') || '';
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
    if (query.number && candidate.house) value += norm(candidate.house) === norm(query.number) ? 260 : -350;
    if (candidate.city && norm(candidate.city) !== norm(userArea.city)) value -= 120;
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
      // Um imóvel com número próprio jamais pode ser fundido a um trecho genérico da rua.
      const key = [norm(c.road), norm(c.district), norm(c.city), norm(c.house)].join('|');
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
    const ordered = candidates.filter(c => !query.number || !c.house || norm(c.house) === norm(query.number))
      .map(c => ({ c, rank: score(c, query, userArea) })).sort((a,b) => b.rank - a.rank).slice(0, 8).map(x=>x.c);
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
      if (query.number && candidate.house && norm(candidate.house) === norm(query.number)) {
        const ok = document.createElement('em'); ok.className = 'verified';
        ok.textContent = 'Número encontrado no cadastro de endereços';
        body.appendChild(ok);
      } else if (query.number) {
        const warn = document.createElement('em');
        warn.textContent = 'Número preservado · posição aproximada da rua';
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
    // Um pedido Photon por alteração de rua, sem duas buscas sequenciais que travavam
    // o campo por segundos. O número permanece na sugestão; busca exata ocorre depois.
    const params = new URLSearchParams({
      q: query.road,
      limit: '12', countrycode: 'BR',
      lat: String(origin.lat), lon: String(origin.lon)
    });
    const json = await photonJSON(`${CFG.photon}/api?${params.toString()}`, signal);
    const found = (Array.isArray(json.features) ? json.features : [])
      .map(featureToCandidate).filter(Boolean);
    // As sugestões precisam corresponder ao nome da rua, não um local de nome parecido.
    return found.filter(c => {
      const street = normalizeRoad(c.road), typed = normalizeRoad(query.road);
      return street === typed || street.startsWith(typed) || typed.startsWith(street);
    });
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

  // ---- Leitor de endereços: um botão, captura de foto no celular e OCR local. ----
  // Tesseract.js é carregado somente quando o usuário realmente seleciona uma imagem.
  // O texto lido é colocado no campo existente, sem cadastrar uma entrega automaticamente.
  let ocrLoadingPromise = null;
  function carregarOCR() {
    if (window.Tesseract?.recognize) return Promise.resolve();
    if (ocrLoadingPromise) return ocrLoadingPromise;
    ocrLoadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.async = true;
      script.onload = () => window.Tesseract?.recognize ? resolve() : reject(new Error('Reconhecimento de texto indisponível.'));
      script.onerror = () => reject(new Error('Não foi possível carregar o leitor. Verifique sua internet.'));
      document.head.appendChild(script);
    }).catch(error => { ocrLoadingPromise = null; throw error; });
    return ocrLoadingPromise;
  }

  function extrairEnderecoDeFoto(texto) {
    // Primeiro uma linha contendo tipo de logradouro; só complementa com a seguinte
    // se esta trouxer explicitamente o número ou o bairro.
    const linhas = String(texto || '').split(/[\r\n]+/)
      .map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const ruaPattern = /\b(?:rua|r\.|avenida|av\.?|travessa|alameda|estrada|rodovia|praça|praca|largo|viela)\b/i;
    const indice = linhas.findIndex(p => ruaPattern.test(p));
    if (indice === -1) return '';
    let endereco = linhas[indice].slice(linhas[indice].search(ruaPattern));
    const detalhes = linhas.slice(indice + 1, indice + 3);
    if (!parseAddress(endereco).number) {
      const n = detalhes.find(p => /^(?:n(?:ú|u)mero|n[º°o]?\.?|#)?\s*[:.#-]?\s*\d{1,5}[A-Za-z]?\b/i.test(p));
      if (n) endereco += ', ' + n.replace(/^(?:n(?:ú|u)mero|n[º°o]?\.?|#)\s*[:.#-]?\s*/i, '');
    }
    const bairro = detalhes.find(p => /\bbairro\b/i.test(p));
    if (bairro && !endereco.toLowerCase().includes(bairro.toLowerCase())) endereco += ', ' + bairro;
    return endereco.replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  ui.scan.addEventListener('click', () => { if (!ui.scan.disabled) ui.scanFile.click(); });
  ui.scanFile.addEventListener('change', async () => {
    const arquivo = ui.scanFile.files?.[0];
    if (!arquivo) return;
    ui.scanFile.value = '';
    if (!arquivo.type.startsWith('image/')) {
      textStatus('Escolha uma foto ou imagem do endereço.', true); return;
    }
    if (arquivo.size > 12 * 1024 * 1024) {
      textStatus('A foto é muito grande. Use uma imagem de até 12 MB.', true); return;
    }
    ui.scan.disabled = true;
    ui.scanLabel.textContent = 'Lendo...';
    textStatus('Lendo o endereço da foto...');
    try {
      await carregarOCR();
      const result = await window.Tesseract.recognize(arquivo, 'por');
      const endereco = extrairEnderecoDeFoto(result?.data?.text);
      if (!endereco) throw new Error('Não identifiquei uma rua na foto. Tire outra foto com o endereço mais nítido.');
      ui.input.value = endereco;
      inputChange(); // inicia o autocompletar normal do RotaFácil
      textStatus('Endereço lido. Confira o número e selecione uma sugestão antes de adicionar.');
      ui.input.focus();
    } catch (error) {
      console.warn('Leitura da foto:', error);
      textStatus(error.message || 'Não foi possível ler o endereço da foto.', true);
    } finally {
      ui.scan.disabled = false;
      ui.scanLabel.textContent = 'Escanear';
    }
  });

  // ---- Geocodificação por número antes de aceitar o centro da rua. ----
  // "Exata" indica que um cadastro identificou rua + número, não que conhecemos a porta.
  // "estimada" usa duas numerações da mesma rua e mesma paridade.
  // "aproximada" significa que só conhecemos uma posição genérica da rua.
  const addressCache = new Map();
  function hasMatchingAddress(candidate,road,house,city) {
    return validPoint(candidate) && normalizeRoad(candidate.road) === normalizeRoad(road) &&
      norm(candidate.house) === norm(house) && (!candidate.city || !city || norm(candidate.city) === norm(city));
  }
  const houseDigits = value => { const m=String(value||'').trim().match(/^(\d+)(?:[a-z])?$/i); return m?Number(m[1]):null; };
  const escapeOverpass = str => String(str).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  const escapePattern = str => String(str).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

  // Somente números documentados na MESMA rua podem dar origem à estimativa.
  // Nunca deduzir uma localização a partir do número isolado (10, 590 etc.).
  function getOSMAddressMatches(elements, road, house, point, city = '', district = '') {
    const targetRoad = normalizeRoad(road);
    const relevant = (Array.isArray(elements) ? elements : []).filter(e =>
      normalizeRoad(e.tags?.['addr:street']) === targetRoad)
      .map(e => ({
        house: String(e.tags?.['addr:housenumber'] || ''),
        lat: Number(e.lat ?? e.center?.lat), lon: Number(e.lon ?? e.center?.lon),
        city: String(e.tags?.['addr:city'] || ''),
        district: String(e.tags?.['addr:suburb'] || e.tags?.['addr:district'] || ''),
        tags: e.tags || {}
      })).filter(validPoint)
      .filter(p => (!point || meters(p, point) <= CFG.addressLookupRadius + 200) &&
        (!city || !p.city || norm(city) === norm(p.city)));
    const direct = relevant.filter(p => norm(p.house) === norm(house))
      .sort((a, b) => Number(Boolean(district && norm(a.district) === norm(district))) * -1 +
        Number(Boolean(district && norm(b.district) === norm(district))) || meters(a, point) - meters(b, point));
    if (direct.length) return { ...direct[0], precision: 'exata', source: 'osm-number' };

    const target = houseDigits(house);
    if (!Number.isFinite(target)) return null;
    const sameParity = relevant.filter(p => houseDigits(p.house) !== null &&
      houseDigits(p.house) % 2 === target % 2).sort((a,b) => houseDigits(a.house) - houseDigits(b.house));
    const guesses = [];
    for (let i = 0; i < sameParity.length - 1; i++) {
      const a = sameParity[i], b = sameParity[i + 1];
      const low = houseDigits(a.house), high = houseDigits(b.house);
      if (low >= target || high <= target) continue;
      const gap = high - low, length = meters(a,b);
      // Avenida longa: permitir intervalos maiores somente com dois pontos existentes
      // e distância física coerente, sem extrapolação fora das âncoras.
      if (gap > 1000 || length > 1100 || length < 6 || length/gap < 0.22 || length/gap > 12) continue;
      // Evitar estimativa que atravesse vários quarteirões sem informação.
      if (gap > 160 && length > 650) continue;
      if (district && a.district && b.district && norm(a.district) !== norm(b.district)) continue;
      const t = (target - low) / gap;
      const latitude = a.lat + (b.lat - a.lat) * t;
      const longitude = a.lon + (b.lon - a.lon) * t;
      guesses.push({lat: latitude, lon: longitude, precision: 'estimada', source: 'osm-interpolation',
        gap, length, proximity: point ? Math.min(meters(a, point), meters(b, point)) : 0 });
    }
    guesses.sort((a,b) => a.gap-b.gap || a.length-b.length || a.proximity-b.proximity);
    return guesses[0] || null;
  }

  async function queryOSMAddress(road, house, approximate, signal, city = '', district = '') {
    if (!validPoint(approximate)) return null;
    const key = `${norm(road)}|${norm(house)}|${norm(city)}|${approximate.lat.toFixed(3)}|${approximate.lon.toFixed(3)}`;
    if (addressCache.has(key)) return addressCache.get(key);
    const core = normalizeRoad(road);
    if (core.length < 3) return null;
    const regex = escapeOverpass(escapePattern(core));
    const num = escapeOverpass(house);
    const radius = CFG.addressLookupRadius;
    // Endereços explicitamente numerados da mesma rua.
    // Usar GET na versão sem servidor; falhas preservam a posição aproximada.
    const q = `[out:json][timeout:7];(nwr(around:${radius},${approximate.lat},${approximate.lon})["addr:housenumber"="${num}"];nwr(around:${radius},${approximate.lat},${approximate.lon})["addr:street"~"${regex}",i]["addr:housenumber"];);out center 250;`;
    const data = await getJSONRemote(`${CFG.overpass}?data=${encodeURIComponent(q)}`,
      {signal,timeout:CFG.addressLookupTimeout});
    const hit = getOSMAddressMatches(data.elements,road,house,approximate,city,district);
    addressCache.set(key,hit);
    if (addressCache.size>45) addressCache.delete(addressCache.keys().next().value);
    return hit;
  }

  async function photonExactHouse(road,house,city,uf,signal) {
    const params=new URLSearchParams({street:road,housenumber:String(house),city,
      countrycode:'BR',limit:'8',lat:String(origin.lat),lon:String(origin.lon)});
    const data=await photonJSON(`${CFG.photon}/structured?${params}`,signal);
    const features=(data.features||[]).map(featureToCandidate).filter(Boolean);
    return features.filter(c=>hasMatchingAddress(c,road,house,city))
      .sort((a,b)=>meters(a,origin)-meters(b,origin))[0]||null;
  }

  async function resolveCoordinates(candidate,userArea,signal) {
    const parsed=parseAddress(candidate.address||ui.input.value);
    const house=String(candidate.typedNumber||candidate.number||candidate.house||parsed.number||'').trim();
    const road=String(candidate.road||parsed.road||'').trim();
    const city=String(candidate.city||userArea.city).trim();
    const uf=/^[A-Z]{2}$/.test(candidate.uf||'')?candidate.uf:userArea.uf;
    const original=validPoint(candidate)?{lat:Number(candidate.lat),lon:Number(candidate.lon)}:null;
    if (!road)throw new Error('Digite o nome da rua.');

    // Se o próprio resultado é um imóvel numerado, utilizar o ponto do imóvel.
    if(house && hasMatchingAddress(candidate,road,house,city)) {
      return {...original,precision:'exata',source:'photon-number'};
    }

    let reference=original;
    if(!reference){
      const q={road,number:house,extra:candidate.district||''};
      const matches=await getPhotonCandidates(q,{city,uf},signal);
      const suitable=matches.filter(c=>normalizeRoad(c.road)===normalizeRoad(road) &&
        (!c.city||norm(c.city)===norm(city))).sort((a,b)=>score(b,q,{city,uf})-score(a,q,{city,uf}))[0];
      if(!suitable)throw new Error('Não conseguimos posicionar essa rua. Escolha outra sugestão.');
      reference={lat:suitable.lat,lon:suitable.lon};
      if(house && hasMatchingAddress(suitable,road,house,city))return {...reference,precision:'exata',source:'photon-number'};
    }
    if(!house)return {...reference,precision:'aproximada',source:'street-reference'};

    // Buscar casa mapeada antes do fallback para o ponto central da rua.
    // As duas fontes são independentes: uma falha não impede o cadastro.
    const jobs=[photonExactHouse(road,house,city,uf,signal).then(p=>
      p?{lat:p.lat,lon:p.lon,precision:'exata',source:'photon-number'}:null).catch(error=>{
        if(signal?.aborted)throw error; console.warn('Endereço por número indisponível:',error);return null;
      }), queryOSMAddress(road,house,reference,signal,city,candidate.district||'').catch(error=>{
        if(signal?.aborted)throw error;console.warn('Imóveis OSM indisponíveis:',error);return null;
      })];
    const results=await Promise.all(jobs);
    const exact=results.find(p=>p?.precision==='exata');
    if(exact)return exact;
    const estimated=results.find(p=>p?.precision==='estimada');
    return estimated||{...reference,precision:'aproximada',source:'street-reference'};
  }
  function stopFromCandidate(c,coordinate,fallback) {
    const addr=c.address||c.raw||fallback;
    return {endereco:addr,lat:coordinate.lat,lon:coordinate.lon,
      number:c.typedNumber||c.number||c.house||parseAddress(addr).number||'',
      city:c.city||area().city,uf:c.uf||area().uf,precision:coordinate.precision,
      road:c.road||parseAddress(addr).road,district:c.district||'',
      propertyLat:coordinate.lat,propertyLon:coordinate.lon,navLat:coordinate.lat,navLon:coordinate.lon,
      locationChecked:false,accessConfirmed:false,locationSource:coordinate.source||''};
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
    textStatus('Procurando o número da casa e a localização da rua...');
    try {
      // Sugestão com coordenadas: cadastro imediato, sem aguardar outra API.
      // O número será verificado em segundo plano, sem prometer precisão fictícia.
      const fastKnown = addressChosen && validPoint(candidate);
      const alreadyExact = fastKnown && candidate.house && candidate.typedNumber &&
        norm(candidate.house) === norm(candidate.typedNumber);
      const coord = fastKnown
        ? { lat: Number(candidate.lat), lon: Number(candidate.lon),
            precision: alreadyExact ? 'exata' : 'aproximada',
            source: alreadyExact ? 'photon-number' : 'street-reference' }
        : await resolveCoordinates(candidate, userArea, ctrl.signal);
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
      const savedStopId = editingId || stops[stops.length - 1].id;
      const shouldRefine = fastKnown && !alreadyExact && Boolean(data.number);
      const wasEditing = Boolean(editingId);
      editingId = null;
      ui.input.value = ''; selected = null;
      ui.add.textContent = '＋ Adicionar entrega';
      ui.cancelEdit.classList.add('hidden');
      searchSeq++; searchController?.abort();
      invalidate(); drawAll(); save();
      textStatus(wasEditing ? 'Endereço atualizado na lista.' : 'Entrega adicionada à lista.');
      if (coord.precision !== 'exata') showToast(coord.precision==='estimada'?'Entrega adicionada com posição estimada pelo número.':'Entrega adicionada com localização aproximada da rua.');
      if (shouldRefine) refineNumberInBackground(savedStopId, candidate, userArea);
    } catch (error) {
      if (error.name === 'AbortError') textStatus('A busca foi interrompida. Tente novamente.', true);
      else if (error.status || error instanceof TypeError)
        textStatus('Não foi possível consultar a localização agora. Escolha uma sugestão com mapa ou tente novamente.', true);
      else textStatus(error.message || 'Não conseguimos localizar este endereço. Tente outra sugestão.', true);
    } finally { setBusy(ui.add, false, ''); if (!editingId) ui.add.textContent = '＋ Adicionar entrega'; }
  });

  async function refineNumberInBackground(id, candidate, userArea) {
    if (refineInProgress.has(id)) return;
    const current = stops.find(p => p.id === id);
    if (!current || !current.number || current.precision === 'exata' || routeValid() || started) return;
    refineInProgress.add(id);
    const originalAddress = current.endereco;
    const startingRevision = routeRevision;
    const controller = new AbortController();
    // Refinamento opcional: o motorista não fica esperando a localização detalhada.
    try {
      const coord = await resolveCoordinates(candidate, userArea, controller.signal);
      const stop = stops.find(p => p.id === id);
      if (!stop || stop.endereco !== originalAddress || startingRevision !== routeRevision || routeValid() || started) return;
      if (coord.precision === 'exata' || coord.precision === 'estimada') {
        stop.lat = coord.lat; stop.lon = coord.lon;
        stop.propertyLat = coord.lat; stop.propertyLon = coord.lon;
        stop.navLat = coord.lat; stop.navLon = coord.lon;
        stop.precision = coord.precision; stop.locationSource = coord.source;
        invalidate(); save(); drawAll();
        if (activeTab === 'mapa') showToast('A localização de uma entrega foi refinada pelo número.');
      }
    } catch (error) {
      console.info('Não foi possível refinar o número; mantendo referência da rua.', error);
    } finally { refineInProgress.delete(id); }
  }

  ui.cancelEdit.addEventListener('click', () => {
    editingId = null; selected = null; ui.input.value = '';
    ui.add.textContent = '＋ Adicionar entrega';
    ui.cancelEdit.classList.add('hidden');
    searchSeq++; searchController?.abort(); clearTimeout(searchTimer); hideSuggestions();
    textStatus('Digite o nome da rua e o número para começar.');
  });

  // ---- Navegação por abas. O mapa só é criado quando sua aba fica visível. ----
  const TAB_LABELS = { entregas:'Minhas entregas', mapa:'Mapa da rota', resumo:'Resumo da rota' };
  function openTab(name, { focusTab = false } = {}) {
    if (!Object.hasOwn(TAB_LABELS, name)) return;
    activeTab = name;
    ui.tabs.forEach(button => {
      const selected = button.dataset.tab === name;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) button.focus();
    });
    ui.panels.forEach(panel => { panel.hidden = panel.id !== `panel-${name}`; });
    ui.activeTabTitle.textContent = TAB_LABELS[name];
    if (name === 'mapa') {
      // Sem container visível, MapLibre pode calcular o tamanho errado (mapa branco).
      requestAnimationFrame(() => {
        if (!mapInitialized) initMap();
        else {
          map?.resize();
          if (mapReady) {
            if (!focusedStopId) fitMap();
            else openMapCard(focusedStopId, {fly:true});
          }
        }
      });
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  ui.tabs.forEach((button, index) => {
    button.addEventListener('click', () => openTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = ui.tabs.length - 1;
      else next = (index + (event.key === 'ArrowRight' ? 1 : -1) + ui.tabs.length) % ui.tabs.length;
      openTab(ui.tabs[next].dataset.tab, { focusTab:true });
    });
  });
  ui.openMap.addEventListener('click', () => openTab('mapa'));
  ui.backDeliveries.addEventListener('click', () => openTab('entregas'));

  // ---- Edição reutilizada pela lista e pelo cartão do mapa. ----
  function editStop(id) {
    const stop = stops.find(p => p.id === id);
    if (!stop) return;
    editingId = id;
    selected = null;
    ui.input.value = stop.endereco;
    ui.add.textContent = '✓ Salvar edição';
    ui.cancelEdit.classList.remove('hidden');
    openTab('entregas');
    textStatus('Edite o endereço, escolha a sugestão correta e clique em Salvar edição.');
    inputChange();
    requestAnimationFrame(() => {
      ui.input.scrollIntoView({ behavior:'smooth', block:'center' });
      ui.input.focus();
    });
  }
  function toggleDone(id) {
    const stop = stops.find(p => p.id === id);
    if (!stop) return;
    const hadPlan = routeValid();
    stop.concluida = !stop.concluida;
    if (!started || !hadPlan) invalidate();
    else { planned.signature = signature(); activeArrivalId = null; }
    ui.arrived.classList.add('hidden');
    save(); drawAll();
  }

  // ---- Cartão flutuante de pino e agrupamento de localizações sobrepostas. ----
  function closeMapCard() {
    focusedStopId = null;
    focusedGroupKey = null;
    ui.mapFloat.classList.add('hidden');
    ui.mapHint.classList.remove('hidden');
    markers.forEach(item => item.element.classList.remove('is-selected'));
  }
  function selectPinMarker(stopId, key = null) {
    markers.forEach(item => item.element.classList.toggle('is-selected',
      key ? item.key === key : item.stopId === stopId));
  }
  function openMapCard(id, { fly = false } = {}) {
    const stop = stops.find(item => item.id === id);
    if (!stop) { closeMapCard(); return; }
    focusedStopId = id;
    focusedGroupKey = null;
    const index = stops.findIndex(item => item.id === id);
    ui.mapFloatLabel.textContent = `PARADA ${String(index+1).padStart(2,'0')}`;
    ui.mapFloatStatus.textContent = stop.concluida ? 'Concluída' : 'Pendente';
    ui.mapFloatAddress.textContent = stop.endereco;
    const precision = stop.precision === 'exata' ? 'Número identificado' : stop.precision === 'estimada' ?
      'Número estimado: confira ao chegar' : 'Ponto aproximado da rua';
    ui.mapFloatDetail.textContent = precision;
    ui.mapFloatNavigate.href = locationURL(stop);
    ui.mapFloatDone.textContent = stop.concluida ? '↶ Desfazer' : '✓ Entregue';
    ui.mapFloatDone.onclick = () => toggleDone(id);
    ui.mapFloatEdit.onclick = () => editStop(id);
    ui.mapFloatChoices.classList.add('hidden');
    ui.mapFloatChoices.replaceChildren();
    ui.mapFloatActions.classList.remove('hidden');
    ui.mapFloat.classList.remove('hidden');
    ui.mapHint.classList.add('hidden');
    selectPinMarker(id);
    if (fly && mapReady) map.easeTo({ center:[stop.lon,stop.lat], zoom:Math.max(15, map.getZoom()),duration:420 });
  }
  function openMapGroup(group, key) {
    focusedStopId = null;
    focusedGroupKey = key;
    ui.mapFloatLabel.textContent = 'PONTO COMPARTILHADO';
    ui.mapFloatStatus.textContent = `${group.length} entregas`;
    ui.mapFloatAddress.textContent = `${group.length} endereços neste ponto`;
    ui.mapFloatDetail.textContent = 'A base de mapas não distingue os números. Escolha um endereço para navegar pelo texto completo.';
    ui.mapFloatChoices.replaceChildren();
    group.forEach(stop => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = stop.endereco;
      item.addEventListener('click', () => openMapCard(stop.id));
      ui.mapFloatChoices.appendChild(item);
    });
    ui.mapFloatChoices.classList.remove('hidden');
    ui.mapFloatActions.classList.add('hidden');
    ui.mapFloat.classList.remove('hidden');
    ui.mapHint.classList.add('hidden');
    selectPinMarker(null, key);
  }
  ui.mapFloatClose.addEventListener('click', closeMapCard);

  // ---- Map. Map errors must never stop address entry. ----
  function initMap() {
    if (mapInitialized) return;
    if (!window.maplibregl) {
      ui.mapPlaceholder.classList.remove('hidden');
      ui.mapStatus.textContent = 'Mapa temporariamente indisponível.';
      return;
    }
    try {
      map = new maplibregl.Map({ container: ui.map, style: CFG.mapStyle,
        center: [origin.lon, origin.lat], zoom: 12.8, attributionControl: true });
      mapInitialized = true;
      map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'bottom-right');
      map.on('load', () => {
        mapReady = true;
        map.resize();
        map.addSource('route-line', { type:'geojson', data:{ type:'FeatureCollection',features:[] } });
        map.addLayer({id:'route-casing',source:'route-line',type:'line',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffffff','line-width':9,'line-opacity':.95}});
        map.addLayer({id:'route-stroke',source:'route-line',type:'line',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#16866a','line-width':5.5,'line-opacity':1}});
        drawMap();
        fitMap();
      });
      map.on('click', () => closeMapCard());
      map.on('error', event => {
        console.warn('Mapa:', event.error);
        if (!mapReady) { ui.mapStatus.textContent='Mapa temporariamente indisponível.';ui.mapPlaceholder.classList.remove('hidden'); }
      });
    } catch (error) {
      console.warn('Mapa indisponível:',error);
      mapInitialized = false;
      ui.mapPlaceholder.classList.remove('hidden');
    }
  }
  function createMarker(label, type, lng, lat, onClick, stopId = null, key = null) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `map-pin ${type}`;
    element.setAttribute('aria-label', 'Abrir detalhes: ' + label);
    const text = document.createElement('span'); text.className='pin-label';text.textContent=label;
    element.appendChild(text);
    element.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    const marker = new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat([lng,lat]).addTo(map);
    markers.push({marker,element,stopId,key});
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
  function duplicateLocations() {
    const byPoint = new Map();
    stops.forEach(stop => {
      if (stop.concluida || stop.precision !== 'aproximada') return;
      // cerca de 3 metros: referência genérica compartilhada, não imóvel confirmado.
      const key = `${Number(stop.lat).toFixed(5)}|${Number(stop.lon).toFixed(5)}`;
      const group = byPoint.get(key) || [];
      group.push(stop);
      byPoint.set(key, group);
    });
    return [...byPoint.values()].filter(group => group.length > 1 &&
      group.some(p => String(p.number || '')) && new Set(group.map(p => p.number)).size > 1);
  }
  function coincidentStopIds() {
    return new Set(duplicateLocations().flatMap(group => group.map(p => p.id)));
  }

  function drawMap() {
    if (!mapReady) return;
    markers.forEach(item=>item.marker.remove());
    markers=[];
    createMarker('⌂','origin',origin.lon,origin.lat,()=> {
      focusedStopId = null;
      ui.mapFloatLabel.textContent = 'PONTO DE PARTIDA';
      ui.mapFloatStatus.textContent = 'Origem';
      ui.mapFloatAddress.textContent = origin.endereco;
      ui.mapFloatDetail.textContent = 'A rota é calculada a partir desta localização.';
      ui.mapFloatChoices.classList.add('hidden');
      ui.mapFloatActions.classList.add('hidden');
      ui.mapFloat.classList.remove('hidden');
      ui.mapHint.classList.add('hidden');
    });
    const next = started ? stops.find(p=>!p.concluida) : null;
    const groups = new Map();
    stops.forEach(stop => {
      // Agrupar coordenadas idênticas evita que um pino esconda outro sem inventar posições.
      const key = `${stop.lat.toFixed(5)}|${stop.lon.toFixed(5)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(stop);
    });
    groups.forEach((group,key) => {
      const p = group[0];
      if (group.length > 1) {
        createMarker(String(group.length),'group',p.lon,p.lat,()=>openMapGroup(group,key),null,key);
      } else {
        const i = stops.findIndex(stop=>stop.id===p.id);
        createMarker(String(i+1), p.concluida?'done':next?.id===p.id?'next':p.precision!=='exata'?'uncertain':'',
          p.lon,p.lat,()=>openMapCard(p.id),p.id);
      }
    });
    const line = routeValid() ? planned.geometry : null;
    const feature = line && line.length > 1 ? {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:line}} : null;
    map.getSource('route-line')?.setData({type:'FeatureCollection',features:feature?[feature]:[]});
    // Linha sempre sólida, seguindo as ruas quando há geometria OSRM.
    // Nunca adicionar line-dasharray (o tracejado anterior confundia usuários).
    if (focusedStopId) openMapCard(focusedStopId);
    else if (focusedGroupKey && groups.has(focusedGroupKey) && groups.get(focusedGroupKey).length>1)
      openMapGroup(groups.get(focusedGroupKey),focusedGroupKey);
    else if (focusedGroupKey) closeMapCard();
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
    if (started && target && target.accessConfirmed === true && gpsFix.accuracy <= 10 && meters(gpsFix,navigationPoint(target)) <= 10) {
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
      gpsFix = {lat:position.coords.latitude,lon:position.coords.longitude,accuracy:Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : Infinity};
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

  // ---- Última milha: pino no imóvel; navegação na rua, se identificada. ----
  async function snapToNamedRoad(point,street) {
    if(!validPoint(point)||!street)return null;
    const cacheKey=`${normalizeRoad(street)}:${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`;
    if(roadSnapCache.has(cacheKey))return roadSnapCache.get(cacheKey);
    try {
      const url=`${CFG.osrm}/nearest/v1/driving/${point.lon},${point.lat}?number=8`;
      const data=await getJSONRemote(url,{timeout:4200});
      if(data.code!=='Ok'||!Array.isArray(data.waypoints))return null;
      const valid=data.waypoints.filter(w=>Array.isArray(w.location)&&
        normalizeRoad(w.name)===normalizeRoad(street)&&Number(w.distance)<=90)
        .sort((a,b)=>a.distance-b.distance);
      if(!valid.length)return null;
      const road={lat:valid[0].location[1],lon:valid[0].location[0]};
      roadSnapCache.set(cacheKey,road);
      if(roadSnapCache.size>70)roadSnapCache.delete(roadSnapCache.keys().next().value);
      return road;
    }catch(error){console.warn('Ponto viário indisponível:',error);return null;}
  }
  async function improvePendingLocations(list,snapshot) {
    const eligible=list.filter(stop=>stop.road&&!stop.locationChecked).slice(0,CFG.maxAddressChecks);
    // limitar solicitações ao serviço público de rotas e não sobrecarregá-lo
    for(const stop of eligible){
      if(routeRevision!==snapshot)return;
      const place={lat:stop.propertyLat??stop.lat,lon:stop.propertyLon??stop.lon};
      const road=await snapToNamedRoad(place,stop.road);
      if(routeRevision!==snapshot)return;
      const current=stops.find(s=>s.id===stop.id);
      if(!current)continue;
      current.navLat=road?road.lat:place.lat;
      current.navLon=road?road.lon:place.lon;
      // Para referência genérica de rua, alinhar o pino ao trecho com nome confirmado.
      // Para imóvel numerado, preservar o pino no próprio imóvel.
      if (road && current.precision === 'aproximada') {
        current.lat=road.lat; current.lon=road.lon;
      }
      current.locationChecked=true;
      current.accessConfirmed=Boolean(road&&stop.precision==='exata');
      // Nunca mover a posição lat/lon do pino do imóvel para a rua.
    }
    save();drawAll();
  }
  const navigationPoint=p=>({lat:p.navLat??p.lat,lon:p.navLon??p.lon});

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
    return { ...data.routes[0], waypoints: Array.isArray(data.waypoints) ? data.waypoints : [] };
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
      await improvePendingLocations(pending,snapshot);
      if (snapshot!==routeRevision) return;
      const points=[origin,...pending.map(navigationPoint)];
      let matrix, matrixApproximate=false;
      try { matrix=points.length-1<=CFG.maxStopsForRoadMatrix ? await getRoadMatrix(points) : distanceMatrix(points);matrixApproximate=points.length-1>CFG.maxStopsForRoadMatrix; }
      catch (error){console.warn('Distâncias por ruas indisponíveis:',error);matrix=distanceMatrix(points);matrixApproximate=true;}
      if(snapshot!==routeRevision) return;
      const best=refine2Opt(greedy(pending,matrix),matrix);
      const ordered=best.map(i=>pending[i-1]);
      let route=null;
      if(ordered.length<=CFG.maxStopsForRoadMatrix) {
        try{route=await getRoadPolyline([origin,...ordered.map(navigationPoint)]);}catch(error){console.warn('Traçado por ruas indisponível:',error);}
      }
      if(snapshot!==routeRevision) return;
      // OSRM pode devolver a posição real usada na malha viária para cada destino.
      // Só alinhar pinos aproximados quando a rua retornada tem o mesmo nome e
      // a posição está a até 80 m da referência anterior. Nunca fingir número exato.
      if (Array.isArray(route?.waypoints) && route.waypoints.length === ordered.length + 1) {
        ordered.forEach((stop,index) => {
          const waypoint=route.waypoints[index+1];
          if (stop.precision !== 'aproximada' || !stop.road || !Array.isArray(waypoint?.location)) return;
          if (normalizeRoad(waypoint.name) !== normalizeRoad(stop.road)) return;
          const aligned={lat:Number(waypoint.location[1]),lon:Number(waypoint.location[0])};
          if (!validPoint(aligned) || meters(stop,aligned)>80) return;
          stop.lat=aligned.lat;stop.lon=aligned.lon;
          stop.navLat=aligned.lat;stop.navLon=aligned.lon;
          stop.locationChecked=true;
        });
      }
      orderPending(ordered);
      const pointsOrdered=[origin,...ordered.map(navigationPoint)];
      const approxKm=pointsOrdered.slice(1).reduce((sum,p,i)=>sum+meters(pointsOrdered[i],p),0)*1.25/1000;
      const km=route ? route.distance/1000 : approxKm;
      const mins=route ? Math.ceil(route.duration/60) : Math.ceil(approxKm/28*60);
      const geometry=route ? route.geometry.coordinates : pointsOrdered.map(p=>[p.lon,p.lat]);
      planned={signature:signature(),order:ordered.map(p=>p.id),km,mins,geometry,
        approximate:matrixApproximate||!route||ordered.some(p=>p.precision!=='exata'), roadLine:Boolean(route)};
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
    const overlapIds=coincidentStopIds();
    stops.forEach((stop,index)=>{
      const card=el('article',`stop${stop.concluida?' completed':''}${next?.id===stop.id?' primary':''}`);
      const num=el('span','stop-index',String(index+1));
      const info=el('div','stop-info');
      info.append(el('strong',stop.concluida?'done':'',stop.endereco));
      info.append(el('small','',`${stop.concluida?'Concluída':'Pendente'} · ${stop.precision==='exata'?'Número identificado no mapa':stop.precision==='estimada'?'Número estimado entre endereços mapeados':'Localização aproximada da rua'}`));
      if(overlapIds.has(stop.id)) info.append(el('small','location-warning','⚠ Número não mapeado: outras entregas usam este mesmo ponto aproximado. Use Navegar para pesquisar o número completo.'));
      const actions=el('div','stop-actions');
      const link=el('a','', '↗ Navegar');link.href=locationURL(stop);link.target='_blank';link.rel='noopener noreferrer';
      const mark=buildButton(stop.concluida?'↶ Desfazer':'✓ Entregue',()=>toggleDone(stop.id),'done-btn');
      const edit=buildButton('✎ Editar',()=>editStop(stop.id));
      const mapJump=buildButton('⌖ Mapa',()=>{
        focusedStopId=stop.id;
        openTab('mapa');
        // O cartão aparece mesmo antes de o mapa terminar de carregar.
        requestAnimationFrame(()=>openMapCard(stop.id,{fly:true}));
      },'map-jump');
      const remove=buildButton('✕',()=>{
        if(!confirm(`Remover a entrega: ${stop.endereco}?`))return;
        stops=stops.filter(x=>x.id!==stop.id);if(editingId===stop.id)editingId=null;
        invalidate();save();drawAll();
      },'remove','Excluir entrega');
      actions.append(mapJump,link,mark,edit,remove);
      card.append(num,info,actions);ui.list.appendChild(card);
    });
  }
  function renderMapRouteInfo() {
    const pendingStops = stops.filter(s => !s.concluida);
    const doneCount = stops.length - pendingStops.length;
    const ready = Boolean(routeValid());
    const current = started ? pendingStops[0] : null;
    ui.mapRoutePending.textContent = String(pendingStops.length);
    ui.mapRouteKm.textContent = ready ? `${planned.km.toFixed(1).replace('.', ',')} km` : '—';
    ui.mapRouteTime.textContent = ready ? `${planned.mins} min` : '—';
    ui.mapRoutePhase.textContent = current ? `Em rota · entrega ${stops.indexOf(current) + 1}` :
      started && !current ? 'Todas as entregas concluídas' : ready ? 'Rota otimizada' :
      stops.length ? 'Preparando sua rota' : 'Nenhuma entrega cadastrada';
    ui.mapRouteNote.textContent = current ? `Destino atual: ${current.endereco}` :
      ready ? `Sequência pronta · ${doneCount} de ${stops.length} concluídas` :
      stops.length ? 'Toque em Otimizar rota na aba Entregas quando terminar de cadastrar.' :
      'Adicione endereços na aba Entregas para ver o percurso aqui.';
    ui.mapSequence.replaceChildren();
    ui.mapSequenceStatus.textContent = ready ? `${pendingStops.length} pendentes` : 'Antes de otimizar';
    ui.mapSequenceHint.textContent = ready
      ? 'Toque em uma parada para localizar no mapa e consultar o endereço.'
      : 'Ordem de cadastro: a sequência definitiva será calculada ao otimizar.';
    if (!stops.length) {
      const item = document.createElement('li'); item.className = 'sequence-empty';
      item.textContent = 'Nenhum destino cadastrado ainda.';
      ui.mapSequence.appendChild(item);
      return;
    }
    stops.forEach((stop, index) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `sequence-stop${stop.concluida?' done':''}${current?.id===stop.id?' current':''}`;
      const number = document.createElement('span'); number.className = 'sequence-number'; number.textContent = String(index + 1);
      const text = document.createElement('span'); text.className = 'sequence-address';
      const address = document.createElement('strong'); address.textContent = stop.endereco;
      const label = document.createElement('small');
      label.textContent = stop.concluida ? '✓ Concluída' : current?.id === stop.id ? '● Entrega atual' :
        ready ? 'Próxima da sequência' : 'Aguardando otimização';
      text.append(address, label);
      btn.append(number, text);
      btn.setAttribute('aria-label', `Ver parada ${index + 1}: ${stop.endereco}`);
      btn.addEventListener('click', () => {
        focusedStopId = stop.id;
        openTab('mapa');
        requestAnimationFrame(() => openMapCard(stop.id, {fly:true}));
      });
      li.appendChild(btn);
      ui.mapSequence.appendChild(li);
    });
  }

  function drawStats() {
    const total=stops.length, done=stops.filter(p=>p.concluida).length,pending=total-done;
    ui.heroCount.textContent=String(pending);
    ui.navCount.textContent=String(total);
    ui.topbarProgress.textContent=total ? `${done} de ${total} entregas concluídas` : 'Seu planejamento começa aqui';
    ui.heroKm.textContent=routeValid()?`${planned.km.toFixed(1).replace('.',',')} km`:'—';
    ui.heroMin.textContent=routeValid()?`${planned.mins} min`:'—';
    const overlapCount=duplicateLocations().flat().length;
    ui.heroNotice.textContent=overlapCount ? `${overlapCount} entregas compartilham localização aproximada: atenção aos números antes de sair.` :
      routeValid()?(planned.approximate?'Rota pronta · alguns pontos são estimados.':'Rota pronta para iniciar.') :total?'Você adicionou endereços. Clique em Otimizar rota quando terminar.':'Adicione suas entregas para começar.';
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
      ui.nextDone.onclick=()=>{ if(!target.concluida) toggleDone(target.id); };
    }else ui.arrived.classList.add('hidden');
  }
  function drawAll(){renderStops();drawStats();renderMapRouteInfo();drawMap();}
  ui.clean.addEventListener('click',()=>{
    const count=stops.filter(p=>p.concluida).length;
    if(!count){showToast('Nenhuma entrega concluída para remover.');return;}
    stops=stops.filter(p=>!p.concluida);invalidate();save();drawAll();
  });
  ui.reset.addEventListener('click',()=>{
    if(!stops.length)return;
    if(!confirm('Apagar todas as entregas e iniciar uma rota nova?'))return;
    stops=[];editingId=null;selected=null;ui.input.value='';closeMapCard();invalidate();save();drawAll();showToast('Lista apagada.');
  });

  // ---- Initialize ----
  drawAll(); // A aba inicial é Entregas; o mapa será carregado ao acessar sua aba.
})();
