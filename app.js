import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';

// RotaFácil 2026 / V4: mapa primeiro, autocomplete, revisão e confirmação do endereço.
// HTML/CSS/JS puro, sem Node.js; Geoapify opcional e Photon público como demonstração.
const CONFIG = Object.freeze({
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
    photon: 'https://photon.komoot.io',
    geoapifyAutocomplete: 'https://api.geoapify.com/v1/geocode/autocomplete',
    geoapifySearch: 'https://api.geoapify.com/v1/geocode/search',
    osrm: 'https://router.project-osrm.org',
    intervaloGpsMs: 5000,
    maxPontosOsrm: 25,
    origemPadrao: { endereco: 'São José dos Campos, SP', lat: -23.1794, lon: -45.8869, personalizado: false }
});

const $ = id => document.getElementById(id);
const ui = {
    form:$('form-parada'), endereco:$('input-endereco'), sugestoes:$('sugestoes-endereco'),
    searchSpinner:$('search-spinner'), status:$('status-formulario'),btnAdicionar:$('btn-adicionar'),
    revisao:$('revisao-endereco'),formRevisao:$('form-revisao'),btnFecharRevisao:$('btn-fechar-revisao'),
    reviewRua:$('review-rua'),reviewNumero:$('review-numero'),reviewBairro:$('review-bairro'),
    reviewCidade:$('review-cidade'),reviewUf:$('review-uf'),reviewCep:$('review-cep'),
    btnConfirmar:$('btn-confirmar-endereco'),btnEditar:$('btn-editar-endereco'),
    btnMarcar:$('btn-marcar-mapa'),btnSalvarAprox:$('btn-salvar-aproximado'),
    precisao:$('resultado-precisao'),aproxAcoes:$('aproximacao-acoes'),
    lista:$('lista-entregas'),contador:$('contador-paradas'),resumo:$('resumo-entregas'),
    btnLimpar:$('btn-limpar'),btnOtimizar:$('btn-otimizar'),btnComecar:$('btn-comecar-rota'),
    btnResetar:$('btn-resetar-rota'),btnCamera:$('btn-camera'),inputCamera:$('input-file-camera'),
    inputOrigem:$('input-origem'),btnGpsOrigem:$('btn-gps-atual'),btnSalvarOrigem:$('btn-salvar-origem'),
    labelOrigem:$('label-status-origem'),ajudaOrigem:$('ajuda-origem'),
    painel:$('painel-bola-da-vez'),numeroProxima:$('numero-bola-da-vez'),enderecoProxima:$('endereco-bola-da-vez'),
    progresso:$('progresso-rota'),btnNavegar:$('btn-navegar-ativa'),btnConcluir:$('btn-concluir-ativa'),
    statusMapa:$('status-mapa'),mapaLoading:$('map-loading'),btnAjustar:$('btn-ajustar-mapa'),
    btnGpsLive:$('btn-gps-live'),btnCentralizarGps:$('btn-centralizar-gps'),gpsStatus:$('gps-status'),
    inputKey:$('input-api-key'),btnSalvarKey:$('btn-salvar-key'),
    metricTotal:$('metric-total'),metricPendentes:$('metric-pendentes'),
    metricConcluidas:$('metric-concluidas'),metricProgress:$('metric-progress'),
    progressBar:$('progress-bar'),progressTrack:$('progress-track'),routeState:$('route-state')
};

const KEYS = {
    paradas: 'rotafacil_paradas', origem: 'rotafacil_origem', iniciada: 'rotafacil_iniciada',
    geoapify: 'rotafacil_geoapify_key'
};
function ler(chave, padrao) {
    try { const dado = localStorage.getItem(chave); return dado === null ? padrao : JSON.parse(dado); }
    catch { return padrao; }
}
function valido(coord) { return Number.isFinite(Number(coord)) && coord !== null && coord !== ''; }
function normalizarParadas(dados) {
    return Array.isArray(dados) ? dados.filter(p => p && valido(p.lat) && valido(p.lon) && typeof p.endereco === 'string')
        .map(p => ({ id: String(p.id), endereco: p.endereco, lat: Number(p.lat), lon: Number(p.lon),
            concluida: Boolean(p.concluida), precisao: p.precisao || 'legado' })) : [];
}
let origem = ler(KEYS.origem, { ...CONFIG.origemPadrao });
if (!origem || !valido(origem.lat) || !valido(origem.lon)) origem = { ...CONFIG.origemPadrao };
let paradas = normalizarParadas(ler(KEYS.paradas, []));
let rotaIniciada = Boolean(ler(KEYS.iniciada, false));
let geoapifyKey = ler(KEYS.geoapify, '');
let marcadores = [];
let mapPronto = false;
let controladorRota = null;
let tokenRota = 0;
let gpsWatchId = null;
let gpsTimer = null;
let ultimaPosicaoGPS = null;
let instanteExibidoGPS = 0;
let marcadorGPS = null;
let acompanharGPS = true;

function salvar() {
    try {
        localStorage.setItem(KEYS.paradas, JSON.stringify(paradas));
        localStorage.setItem(KEYS.origem, JSON.stringify(origem));
        localStorage.setItem(KEYS.iniciada, JSON.stringify(rotaIniciada));
    } catch (err) { console.error('Falha ao salvar:', err); avisar('Falha no armazenamento local do navegador.', true); }
}
function avisar(texto, erro = false) {
    ui.status.textContent = texto;
    ui.status.className = `form-message ${erro ? 'is-error' : ''}`;
}
function carregando(botao, ativo, texto) {
    if (ativo) {
        botao.dataset.original = botao.innerHTML;
        botao.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${texto}`;
    } else if (botao.dataset.original) {
        botao.innerHTML = botao.dataset.original;
        delete botao.dataset.original;
    }
    botao.disabled = ativo;
}
function escapeHtml(texto) {
    return String(texto).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const distanciaMetros = (a, b) => {
    const rad = g => g * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};
function enderecoMaps(parada) {
    return `https://www.google.com/maps/dir/?api=1&destination=${parada.precisao === 'aproximado' ? encodeURIComponent(parada.endereco) : `${parada.lat},${parada.lon}`}&travelmode=driving`;
}

// ------------------------ MAPA VETORIAL ------------------------
// O OpenFreeMap não usa o servidor de tiles da OSM que estava retornando 403.
let mapa;
try {
    mapa = new maplibregl.Map({
        container: 'map', style: CONFIG.mapStyle,
        center: [Number(origem.lon), Number(origem.lat)], zoom: 13,
        minZoom: 1, attributionControl: true
    });
    mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapa.on('load', () => {
        mapPronto = true;
        mapa.addSource('percurso', { type: 'geojson', data: linhaVazia() });
        mapa.addLayer({ id: 'percurso-linha', type: 'line', source: 'percurso',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#246d61', 'line-width': 5, 'line-opacity': .95 } });
        mapa.addSource('margem-gps', { type: 'geojson', data: areaVazia() });
        mapa.addLayer({ id: 'margem-gps-fill', type: 'fill', source: 'margem-gps',
            paint: { 'fill-color': '#348eea', 'fill-opacity': .13 } }, 'percurso-linha');
        mapa.addLayer({ id: 'margem-gps-borda', type: 'line', source: 'margem-gps',
            paint: { 'line-color': '#348eea', 'line-width': 1.4, 'line-opacity': .6 } }, 'percurso-linha');
        desenharMarcadores();
        enquadrar();
        desenharRota();
    });
    mapa.on('error', evento => {
        console.warn('Erro no mapa:', evento.error);
        if (!mapPronto) ui.statusMapa.textContent = 'Não foi possível carregar o mapa. Abra F12 → Rede e veja qual URL falhou.';
    });
    mapa.on('click', evento => {
        if (!escolhendoPonto) return;
        escolherCoordenadasManuais(evento.lngLat.lat, evento.lngLat.lng);
    });
    mapa.on('dragstart', () => { acompanharGPS = false; });
} catch (erro) {
    console.error('Falha ao inicializar mapa:', erro);
    ui.statusMapa.textContent = 'Não foi possível iniciar o mapa. Confira a conexão.';
}
function linhaVazia() { return { type: 'FeatureCollection', features: [] }; }
function areaVazia() { return { type: 'FeatureCollection', features: [] }; }
function colocarLinha(coordenadas) {
    if (mapPronto && mapa.getSource('percurso')) {
        mapa.getSource('percurso').setData(coordenadas.length < 2 ? linhaVazia() :
            { type:'Feature', properties:{}, geometry:{type:'LineString', coordinates:coordenadas} });
    }
}
function criarPin(numero, classe = '') {
    const elemento = document.createElement('div');
    elemento.className = `map-pin ${classe}`;
    elemento.textContent = String(numero);
    return elemento;
}
function desenharMarcadores() {
    if (!mapPronto) return;
    marcadores.forEach(m => m.remove());
    marcadores = [];
    let marcador = new maplibregl.Marker({ element: criarPin('⌂', 'origem'), anchor: 'center' })
        .setLngLat([Number(origem.lon), Number(origem.lat)])
        .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(`<b>Origem</b><br>${escapeHtml(origem.endereco)}`))
        .addTo(mapa);
    marcadores.push(marcador);
    const proxima = paradas.find(p => !p.concluida);
    for (const [indice, p] of paradas.entries()) {
        const classe = p.concluida ? 'concluida' : (rotaIniciada && proxima?.id === p.id ? 'proxima' : '');
        marcador = new maplibregl.Marker({ element: criarPin(indice + 1, classe), anchor: 'center' })
            .setLngLat([p.lon, p.lat])
            .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(
                `<b>Parada ${indice + 1}</b><br>${escapeHtml(p.endereco)}<br><small>${p.precisao === 'confirmado' ? 'Número identificado' : p.precisao === 'manual' ? 'Ponto escolhido manualmente' : 'Localização aproximada/antiga'}</small>`))
            .addTo(mapa);
        marcadores.push(marcador);
    }
}
function enquadrar() {
    if (!mapa) return;
    const pontos = [[Number(origem.lon), Number(origem.lat)], ...paradas.map(p => [p.lon, p.lat])];
    if (pontos.length < 2) mapa.easeTo({ center: pontos[0], zoom: 14, duration: 300 });
    else {
        const bounds = new maplibregl.LngLatBounds(pontos[0], pontos[0]);
        pontos.forEach(p => bounds.extend(p));
        mapa.fitBounds(bounds, { padding: 45, maxZoom: 16, duration: 450 });
    }
}
function getPontosRota() {
    const pendentes = rotaIniciada ? paradas.filter(p => !p.concluida) : paradas;
    if (!pendentes.length) return [];
    const partida = rotaIniciada && ultimaPosicaoGPS
        ? { lat: ultimaPosicaoGPS.lat, lon: ultimaPosicaoGPS.lon } : origem;
    return [partida, ...pendentes];
}
async function desenharRota() {
    if (!mapPronto) return;
    const idAtual = ++tokenRota;
    if (controladorRota) controladorRota.abort();
    controladorRota = new AbortController();
    const pontos = getPontosRota();
    if (!pontos.length) { colocarLinha([]); ui.statusMapa.textContent = 'Adicione paradas para visualizar o percurso'; return; }
    const coordenadas = pontos.map(p => [p.lon, p.lat]);
    if (pontos.length > CONFIG.maxPontosOsrm) {
        colocarLinha(coordenadas);
        ui.statusMapa.textContent = 'Muitas paradas para este servidor: linha ilustrativa (não segue ruas).';
        return;
    }
    ui.mapaLoading.classList.remove('hidden');
    ui.statusMapa.textContent = 'Calculando trajeto pelas ruas...';
    try {
        const texto = coordenadas.map(p => p.join(',')).join(';');
        const resposta = await fetch(`${CONFIG.osrm}/route/v1/driving/${texto}?overview=full&geometries=geojson`,
            { signal: controladorRota.signal });
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
        const dados = await resposta.json();
        if (dados.code !== 'Ok' || !dados.routes?.length) throw new Error(dados.message || 'Rota não encontrada');
        if (idAtual !== tokenRota) return;
        colocarLinha(dados.routes[0].geometry.coordinates);
        const km = (dados.routes[0].distance / 1000).toFixed(1).replace('.', ',');
        const min = Math.round(dados.routes[0].duration / 60);
        ui.statusMapa.textContent = `Percurso estimado: ${km} km · ${min} min`;
    } catch (erro) {
        if (idAtual !== tokenRota || erro.name === 'AbortError') return;
        colocarLinha(coordenadas);
        ui.statusMapa.textContent = 'Serviço de rotas indisponível. Linha ilustrativa (não segue ruas).';
        console.warn('OSRM:', erro);
    } finally {
        if (idAtual === tokenRota) ui.mapaLoading.classList.add('hidden');
    }
}

// ------------------- AUTOCOMPLETAR E CONFERIR ENDEREÇOS -------------------
// Geoapify: autocomplete + geocoding estruturado (com chave).
// Photon: alternativa pública de busca ao digitar, com limitações de disponibilidade.
// Não usamos Nominatim público para autocomplete: o regulamento dele proíbe esse uso.
const AUTOCOMPLETE_DELAY = 650;
let timerSugestoes = null;
let controllerSugestoes = null;
let sequenciaSugestoes = 0;
let itensSugestoes = [];
let indiceTeclado = -1;
let revisaoAtiva = false;
let coordenadaManual = null;
let candidatoAproximado = null;
let escolhendoPonto = false;
let marcadorPrevia = null;
let textoBuscaSelecionado = '';
const cacheSugestoes = new Map();

function normalizar(texto) {
    return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\b(rua|r\.?|avenida|av\.?|travessa|tv\.?|alameda|al\.?)\b/g, '')
        .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
function mesmoNumero(a, b) { return normalizar(a) !== '' && normalizar(a) === normalizar(b); }
function mesmaRua(a, b) {
    const x = normalizar(a), y = normalizar(b);
    return Boolean(x && y && (x === y || (x.length > 5 && y.includes(x)) || (y.length > 5 && x.includes(y))));
}
function extrairDigitacao(texto) {
    // Pega o ÚLTIMO número de imóvel, preservando números dentro de nomes de ruas.
    const original = String(texto || '').trim();
    const semCep = original.replace(/\b\d{5}-?\d{3}\b/g, cep => ' '.repeat(cep.length));
    const encontrados = [...semCep.matchAll(/\b\d{1,5}[A-Za-z]?\b/g)];
    const m = encontrados.at(-1);
    if (!m) return { rua:original, numero:'', bairro:'', cidade:'São José dos Campos', uf:'SP', cep:'' };
    const rua = original.slice(0, m.index).replace(/(?:\b(?:n|nº|n°|numero|número)\.?\s*)$/i,'').replace(/[\s,;:\-]+$/,'').trim();
    const resto = original.slice(m.index + m[0].length).replace(/^[\s,;:\-]+/,'').trim();
    let bairro = resto;
    let cidade = 'São José dos Campos';
    const reconhecida = resto.match(/(?:,\s*)?(São José dos Campos|Jacareí|Caçapava|Taubaté|Pindamonhangaba)(?:\s*,?\s*(SP))?$/i);
    if (reconhecida) { cidade = reconhecida[1]; bairro = resto.slice(0,reconhecida.index).replace(/[\s,]+$/,''); }
    return {rua:rua || original, numero:m[0], bairro, cidade, uf:'SP', cep:''};
}
function formularioRevisao() {
    return {
        rua:ui.reviewRua.value.trim(), numero:ui.reviewNumero.value.trim(),
        bairro:ui.reviewBairro.value.trim(), cidade:ui.reviewCidade.value.trim(),
        uf:ui.reviewUf.value.trim().toUpperCase(), cep:ui.reviewCep.value.trim()
    };
}
function formatarEndereco(endereco) {
    return [endereco.rua + (endereco.numero ? `, ${endereco.numero}` : ''),
        endereco.bairro, `${endereco.cidade}${endereco.uf ? ` - ${endereco.uf}` : ''}`,
        endereco.cep ? `CEP ${endereco.cep}` : ''].filter(Boolean).join(' — ');
}
function consultaEndereco(e) {
    return [e.rua + (e.numero ? `, ${e.numero}` : ''), e.bairro, e.cidade, e.uf, e.cep, 'Brasil'].filter(Boolean).join(', ');
}
function modoPrecisao(tipo, texto) {
    ui.precisao.className = `accuracy-message ${tipo === 'warning' ? 'is-warning' : tipo === 'success' ? 'is-success' : ''}`;
    ui.precisao.replaceChildren();
    const icone = document.createElement('i'); icone.className = `fa-solid ${tipo === 'success' ? 'fa-circle-check' : tipo === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info'}`;
    const conteudo = document.createElement('span'); conteudo.textContent = texto;
    ui.precisao.append(icone,conteudo);
}
function limparSugestoes() {
    ui.sugestoes.replaceChildren();
    ui.sugestoes.classList.add('hidden');
    ui.endereco.setAttribute('aria-expanded','false');
    indiceTeclado = -1;
    itensSugestoes = [];
}
function pararBuscaSugestoes() {
    clearTimeout(timerSugestoes);
    if (controllerSugestoes) controllerSugestoes.abort();
    controllerSugestoes = null;
    ++sequenciaSugestoes;
    ui.searchSpinner.classList.add('hidden');
}
function fecharRevisao() {
    revisaoAtiva = false;
    ui.revisao.classList.add('hidden');
    ui.aproxAcoes.classList.add('hidden');
    coordenadaManual = null; candidatoAproximado = null;
    cancelarModoMapa();
}
function prepararRevisao(sugestao = null) {
    pararBuscaSugestoes();
    limparSugestoes();
    const digitado = extrairDigitacao(textoBuscaSelecionado || ui.endereco.value);
    const dados = {
        rua:sugestao?.rua || digitado.rua,
        numero:digitado.numero || sugestao?.numero || '',
        bairro:sugestao?.bairro || digitado.bairro || '',
        cidade:sugestao?.cidade || digitado.cidade || 'São José dos Campos',
        uf:sugestao?.uf || digitado.uf || 'SP', cep:sugestao?.cep || digitado.cep || ''
    };
    ui.reviewRua.value = dados.rua;
    ui.reviewNumero.value = dados.numero;
    ui.reviewBairro.value = dados.bairro;
    ui.reviewCidade.value = dados.cidade;
    ui.reviewUf.value = dados.uf;
    ui.reviewCep.value = dados.cep;
    ui.endereco.value = formatarEndereco(dados);
    coordenadaManual = null; candidatoAproximado = null;
    ui.aproxAcoes.classList.add('hidden');
    modoPrecisao('normal', 'Confira todos os dados. Ao clicar em OK, o aplicativo consulta novamente o endereço completo e a numeração.');
    ui.revisao.classList.remove('hidden'); revisaoAtiva = true;
    ui.revisao.scrollIntoView({behavior:'smooth',block:'nearest'});
    if (sugestao && mapa) mapa.flyTo({center:[sugestao.lon,sugestao.lat],zoom:16,duration:550});
}
function candidatoGeoapify(p, leitura) {
    if (!valido(p.lat) || !valido(p.lon) || !p.street) return null;
    return {
        rua:p.street, numero:String(p.housenumber || ''), bairro:p.suburb || p.district || p.county || '',
        cidade:p.city || p.town || p.municipality || leitura.cidade, uf:p.state_code || leitura.uf,
        cep:p.postcode || '', lat:Number(p.lat), lon:Number(p.lon), fonte:'Geoapify',
        resultType:p.result_type || '', rank:p.rank || {},
        exato:Boolean(leitura.numero && mesmoNumero(p.housenumber, leitura.numero) &&
            p.result_type === 'building' && Boolean(p.city) && Number(p.rank?.confidence_building_level || 0) >= .65)
    };
}
function candidatoPhoton(feature, leitura) {
    const p = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    const rua = p.street || (['street','house'].includes(p.type) ? p.name : '');
    if (!rua || !valido(coords[0]) || !valido(coords[1])) return null;
    const uf = /s[aã]o paulo/i.test(p.state || '') ? 'SP' : (p.state?.length === 2 ? p.state.toUpperCase() : leitura.uf);
    return { rua, numero:String(p.housenumber || ''), bairro:p.district || p.locality || p.suburb || '',
        cidade:p.city || leitura.cidade, uf, cep:p.postcode || '',lat:Number(coords[1]),lon:Number(coords[0]),
        fonte:'Photon / OpenStreetMap', resultType:p.osm_value || p.type || '', rank:{},
        exato:Boolean(leitura.numero && Boolean(p.city) && mesmoNumero(p.housenumber, leitura.numero)) };
}
async function fetchJson(url, {signal} = {}) {
    const resposta = await fetch(url,{signal,headers:{Accept:'application/json'}});
    if (!resposta.ok) throw new Error(`Busca indisponível (HTTP ${resposta.status}). Confira sua conexão ou a chave configurada.`);
    return resposta.json();
}
async function sugerirGeoapify(termo, signal) {
    const leitura = extrairDigitacao(termo);
    const query = new URLSearchParams({
        text:termo, format:'json',limit:'8', lang:'pt', filter:'countrycode:br',
        bias:`proximity:${origem.lon},${origem.lat}`,apiKey:geoapifyKey
    });
    const json = await fetchJson(`${CONFIG.geoapifyAutocomplete}?${query}`,{signal});
    return (json.results || []).map(p => candidatoGeoapify(p, leitura)).filter(Boolean);
}
async function sugerirPhoton(termo, signal, segundaTentativa=true) {
    const leitura = extrairDigitacao(termo);
    const params = new URLSearchParams({q:termo, limit:'8', lang:'pt',lat:String(origem.lat),lon:String(origem.lon)});
    const dados = await fetchJson(`${CONFIG.photon}/api/?${params}`,{signal});
    let itens = (dados.features || []).map(p => candidatoPhoton(p, leitura)).filter(Boolean);
    // A base nem sempre reconhece números: pedir sugestões apenas para a rua preserva o número digitado.
    if (!itens.some(d => mesmaRua(leitura.rua,d.rua)) && leitura.numero && segundaTentativa) {
        const buscaRua = [leitura.rua,leitura.bairro,leitura.cidade].filter(Boolean).join(' ');
        itens = await sugerirPhoton(buscaRua, signal, false);
    }
    return itens;
}
function sugestoesUnicas(dados, digitacao) {
    const unicos = new Set();
    return dados.filter(d => {
        if (!mesmaRua(digitacao.rua,d.rua)) return false;
        const chave = [normalizar(d.rua),normalizar(d.bairro),normalizar(d.cidade),d.numero,d.lat.toFixed(4),d.lon.toFixed(4)].join('|');
        if (unicos.has(chave)) return false;
        unicos.add(chave); return true;
    }).sort((a,b) => {
        const pontuar = x => (mesmaRua(digitacao.rua,x.rua)?20:0) +
            (digitacao.numero && mesmoNumero(digitacao.numero,x.numero)?25:0) +
            (digitacao.bairro && normalizar(x.bairro).includes(normalizar(digitacao.bairro))?8:0) +
            (normalizar(x.cidade).includes(normalizar(digitacao.cidade))?3:0);
        return pontuar(b)-pontuar(a);
    }).slice(0,6);
}
async function buscarSugestoes(termo,{force=false}={}) {
    const seq = ++sequenciaSugestoes;
    if (controllerSugestoes) controllerSugestoes.abort();
    controllerSugestoes = new AbortController();
    const signal = controllerSugestoes.signal;
    ui.searchSpinner.classList.remove('hidden');
    try {
        const chave = `${geoapifyKey ? 'geo' : 'photon'}:${normalizar(termo)}`;
        let dados = cacheSugestoes.get(chave);
        if (!dados) {
            dados = geoapifyKey ? await sugerirGeoapify(termo,signal) : await sugerirPhoton(termo,signal);
            cacheSugestoes.set(chave,dados);
            if (cacheSugestoes.size > 55) cacheSugestoes.delete(cacheSugestoes.keys().next().value);
        }
        if (seq !== sequenciaSugestoes || ui.endereco.value.trim() !== termo) return;
        itensSugestoes = sugestoesUnicas(dados,extrairDigitacao(termo));
        desenharSugestoes(termo,force);
    } catch(erro) {
        if (erro.name !== 'AbortError' && seq === sequenciaSugestoes) {
            limparSugestoes();
            if (force) prepararRevisao();
            avisar(`${erro.message} Você ainda pode preencher o endereço manualmente e ajustar o pino.`,true);
        }
    } finally {if (seq === sequenciaSugestoes) ui.searchSpinner.classList.add('hidden');}
}
function desenharSugestoes(termo,force) {
    ui.sugestoes.replaceChildren();
    if (!itensSugestoes.length) {
        if (force) { prepararRevisao(); avisar('Sem sugestão para esse endereço. Confira os campos e ajuste o pino, se necessário.'); }
        else {ui.sugestoes.classList.remove('hidden');ui.endereco.setAttribute('aria-expanded','true');const mensagem=document.createElement('div');mensagem.className='suggestion-empty';mensagem.textContent='Nenhuma sugestão neste momento. Continue digitando ou clique em Buscar para revisar manualmente.';ui.sugestoes.append(mensagem);}
        return;
    }
    const leitura=extrairDigitacao(termo);
    itensSugestoes.forEach((dado,index) => {
        const botao=document.createElement('button');botao.type='button';botao.className='suggestion';botao.setAttribute('role','option');botao.id=`sugestao-${index}`;
        const icone=document.createElement('i');icone.className='fa-solid fa-location-dot';
        const bloco=document.createElement('span');
        const rua=document.createElement('strong');rua.textContent=`${dado.rua}${leitura.numero ? `, ${leitura.numero}` : dado.numero ? `, ${dado.numero}` : ''}`;
        const local=document.createElement('small');local.textContent=[dado.bairro,`${dado.cidade} · ${dado.uf}`,dado.cep ? `CEP ${dado.cep}`:''].filter(Boolean).join(' · ');
        bloco.append(rua,local);
        if (leitura.numero && !dado.exato) {const aviso=document.createElement('em');aviso.textContent=`Nº ${leitura.numero} solicitado · ainda não confirmado`;bloco.append(aviso);}
        botao.append(icone,bloco);
        botao.addEventListener('click',()=>{textoBuscaSelecionado=termo;prepararRevisao(dado);});
        ui.sugestoes.append(botao);
    });
    ui.sugestoes.classList.remove('hidden');ui.endereco.setAttribute('aria-expanded','true');
    if (force) avisar('Escolha um endereço na lista para revisar e confirmar.');
}
ui.endereco.addEventListener('input',()=>{
    pararBuscaSugestoes();limparSugestoes();fecharRevisao();textoBuscaSelecionado='';
    const termo=ui.endereco.value.trim();
    if (termo.length < 4) return;
    timerSugestoes=setTimeout(()=>buscarSugestoes(termo),AUTOCOMPLETE_DELAY);
});
ui.endereco.addEventListener('keydown',evento=>{
    const itens=Array.from(ui.sugestoes.querySelectorAll('[role="option"]'));
    if (!itens.length || ui.sugestoes.classList.contains('hidden')) return;
    if (evento.key==='ArrowDown'||evento.key==='ArrowUp') {
        evento.preventDefault();indiceTeclado = evento.key==='ArrowDown' ? (indiceTeclado+1)%itens.length : (indiceTeclado-1+itens.length)%itens.length;
        itens.forEach((e,i)=>e.classList.toggle('is-focused',i===indiceTeclado));
        ui.endereco.setAttribute('aria-activedescendant',itens[indiceTeclado].id);
    } else if (evento.key==='Enter'&&indiceTeclado>=0) {
        evento.preventDefault();itens[indiceTeclado].click();
    } else if (evento.key==='Escape') limparSugestoes();
});
document.addEventListener('click',evento=>{
    if (!ui.endereco.closest('.search-area').contains(evento.target)) limparSugestoes();
});
ui.form.addEventListener('submit',async evento=>{
    evento.preventDefault();const termo=ui.endereco.value.trim();
    if (termo.length<3) return;
    textoBuscaSelecionado=termo;
    if (!ui.sugestoes.classList.contains('hidden')&&itensSugestoes.length) {avisar('Escolha uma sugestão da lista para revisar o endereço.');return;}
    carregando(ui.btnAdicionar,true,'Buscando...');
    try {await buscarSugestoes(termo,{force:true});}
    finally {carregando(ui.btnAdicionar,false);}
});

async function resolverEnderecoGeoapify(campos,signal) {
    // Inclui o BAIRRO editado na geocodificação, e não apenas rua/número/cidade.
    const params=new URLSearchParams({
        text:consultaEndereco(campos),format:'json',limit:'8',filter:'countrycode:br',
        bias:`proximity:${origem.lon},${origem.lat}`,apiKey:geoapifyKey
    });
    let dados=await fetchJson(`${CONFIG.geoapifySearch}?${params}`,{signal});
    let resultados=(dados.results||[]).map(p=>candidatoGeoapify(p,campos)).filter(Boolean);
    if (!resultados.some(d => d.exato) && campos.numero) {
        // Segunda tentativa estruturada, útil quando a base desconhece o nome do bairro.
        const estruturada=new URLSearchParams({street:campos.rua,housenumber:campos.numero,
            city:campos.cidade,format:'json',limit:'7',filter:'countrycode:br',
            bias:`proximity:${origem.lon},${origem.lat}`,apiKey:geoapifyKey});
        if (campos.cep) estruturada.set('postcode',campos.cep);
        dados=await fetchJson(`${CONFIG.geoapifySearch}?${estruturada}`,{signal});
        resultados.push(...(dados.results||[]).map(p=>candidatoGeoapify(p,campos)).filter(Boolean));
    }
    return resultados;
}
async function resolverEnderecoPhoton(campos,signal) {
    const pesquisa=consultaEndereco(campos);
    const lista=await sugerirPhoton(pesquisa,signal);
    return lista;
}
function selecionarMelhorResultado(lista,campos) {
    const compativeis=lista.filter(p=>mesmaRua(campos.rua,p.rua));
    const compararCidade=p=>!campos.cidade||normalizar(p.cidade)===normalizar(campos.cidade);
    const compararBairro=p=>!campos.bairro||!p.bairro||normalizar(p.bairro)===normalizar(campos.bairro);
    const pontuar=p=>(compararCidade(p)?30:0)+(compararBairro(p)?12:0)+
        (campos.numero&&mesmoNumero(campos.numero,p.numero)?20:0)+(p.exato?10:0);
    compativeis.sort((a,b)=>pontuar(b)-pontuar(a));
    const candidato=compativeis[0];
    if (!candidato) return null;
    // Número encontrado não significa prédio correto se a cidade/bairro foram confundidos.
    const exato=Boolean(candidato.exato&&compararCidade(candidato)&&compararBairro(candidato));
    return {...candidato,exato};
}
async function resolverEnderecoFinal(campos,{signal}={}) {
    const lista=geoapifyKey
        ? await resolverEnderecoGeoapify(campos,signal)
        : await resolverEnderecoPhoton(campos,signal);
    return selecionarMelhorResultado(lista,campos);
}
function cancelarModoMapa() {
    escolhendoPonto=false;document.body.classList.remove('modo-marcar-mapa');
    if (marcadorPrevia) marcadorPrevia.remove();marcadorPrevia=null;
}
function adicionarParada(endereco,lat,lon,precisao) {
    paradas.push({id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,endereco,lat,lon,
        concluida:false,precisao});
    ui.endereco.value='';textoBuscaSelecionado='';fecharRevisao();limparSugestoes();
    avisar(precisao==='confirmado'?'Parada adicionada: o número consta na base de endereços. Confira o pino no mapa.':
        precisao==='manual'?'Parada adicionada no ponto escolhido por você.':'Parada salva como aproximada. Confira antes de navegar.');
    renderizar();
}
ui.formRevisao.addEventListener('submit',async evento=>{
    evento.preventDefault();
    const campos=formularioRevisao();
    if (!campos.rua||!campos.cidade||!campos.uf) {modoPrecisao('warning','Preencha rua, cidade e UF.');return;}
    const endereco=formatarEndereco(campos);
    if (coordenadaManual) {
        adicionarParada(endereco,coordenadaManual.lat,coordenadaManual.lon,'manual');return;
    }
    carregando(ui.btnConfirmar,true,'Verificando...');
    candidatoAproximado=null;ui.aproxAcoes.classList.add('hidden');
    modoPrecisao('normal','Buscando novamente o endereço com as informações revisadas...');
    try {
        const resposta=await resolverEnderecoFinal(campos);
        if (!resposta) {
            modoPrecisao('warning','Não foi possível confirmar a rua informada. Revise os campos ou ajuste o pino manualmente no mapa.');
            return;
        }
        if (mapa) mapa.flyTo({center:[resposta.lon,resposta.lat],zoom:17,duration:650});
        if (resposta.exato) {
            adicionarParada(endereco,resposta.lat,resposta.lon,'confirmado');
        } else {
            candidatoAproximado={...resposta,endereco};
            ui.aproxAcoes.classList.remove('hidden');
            modoPrecisao('warning',`Encontramos ${resposta.rua}, mas o número ${campos.numero||'não informado'} NÃO foi confirmado como posição de imóvel. O pino exibido pode representar outro ponto da rua. Se possível, ajuste no mapa.`);
        }
    } catch(erro) {
        modoPrecisao('warning',`${erro.message} Tente novamente ou marque o local manualmente.`);
    } finally {carregando(ui.btnConfirmar,false);}
});
ui.btnSalvarAprox.addEventListener('click',()=>{
    if (!candidatoAproximado) return;
    adicionarParada(candidatoAproximado.endereco,candidatoAproximado.lat,candidatoAproximado.lon,'aproximado');
});
ui.btnEditar.addEventListener('click',()=>{ui.reviewRua.focus();ui.reviewRua.select();});
ui.btnFecharRevisao.addEventListener('click',()=>{fecharRevisao();avisar('Revisão cancelada. Digite ou escolha outro endereço.');});
for (const campo of [ui.reviewRua,ui.reviewNumero,ui.reviewBairro,ui.reviewCidade,ui.reviewUf,ui.reviewCep]) {
    campo.addEventListener('input',()=>{
        candidatoAproximado=null;coordenadaManual=null;ui.aproxAcoes.classList.add('hidden');
        cancelarModoMapa();modoPrecisao('normal','Endereço alterado. Clique em OK para pesquisar novamente usando os dados corrigidos.');
    });
}
ui.btnMarcar.addEventListener('click',()=>{
    if (!revisaoAtiva) return;
    escolhendoPonto=true;document.body.classList.add('modo-marcar-mapa');
    modoPrecisao('warning','Toque ou clique no local exato do imóvel no mapa. Depois volte e clique em OK para confirmar.');
    document.getElementById('mapa').scrollIntoView({behavior:'smooth',block:'start'});
});
function escolherCoordenadasManuais(lat,lon) {
    cancelarModoMapa();coordenadaManual={lat,lon};candidatoAproximado=null;
    ui.aproxAcoes.classList.add('hidden');
    if (mapa) {
        const elemento=document.createElement('div');elemento.className='preview-pin';elemento.innerHTML='<i class="fa-solid fa-check"></i>';
        marcadorPrevia=new maplibregl.Marker({element:elemento,anchor:'bottom'}).setLngLat([lon,lat]).addTo(mapa);
    }
    modoPrecisao('success',`Pino definido manualmente (${lat.toFixed(5)}, ${lon.toFixed(5)}). Agora clique em OK para adicionar esta parada.`);
    ui.revisao.scrollIntoView({behavior:'smooth',block:'center'});
}
ui.inputKey.value=geoapifyKey;
ui.btnSalvarKey.addEventListener('click',()=>{
    geoapifyKey=ui.inputKey.value.trim();
    try {localStorage.setItem(KEYS.geoapify,JSON.stringify(geoapifyKey));}
    catch {avisar('Não foi possível salvar a chave.',true);return;}
    cacheSugestoes.clear();pararBuscaSugestoes();limparSugestoes();
    avisar(geoapifyKey?'Geoapify ativado. A busca automática agora usa este provedor.':'Chave removida. A busca automática usa o Photon público (modo demonstrativo).');
});

// ------------------------- ORIGEM -------------------------
async function salvarOrigemDigitada() {
    const texto=ui.inputOrigem.value.trim();
    if (!texto) {avisar('Digite um endereço de origem.',true);return;}
    carregando(ui.btnSalvarOrigem,true,'Buscando...');
    try {
        const campos=extrairDigitacao(texto);
        const melhor=await resolverEnderecoFinal(campos);
        if (!melhor) throw new Error('Origem não localizada. Revise o endereço ou use Meu GPS.');
        if (!melhor.exato && campos.numero && !confirm('O número da origem não foi confirmado. Deseja usar uma posição aproximada?')) return;
        origem={endereco:texto,lat:melhor.lat,lon:melhor.lon,personalizado:true};
        ui.labelOrigem.textContent='Origem definida';
        renderizar();avisar('Ponto de partida atualizado.');
    } catch(erro) {avisar(erro.message,true);}
    finally {carregando(ui.btnSalvarOrigem,false);}
}
ui.btnSalvarOrigem.addEventListener('click', salvarOrigemDigitada);
ui.inputOrigem.addEventListener('keydown', evento => { if (evento.key === 'Enter') { evento.preventDefault(); salvarOrigemDigitada(); } });
ui.btnGpsOrigem.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { avisar('Seu dispositivo não oferece geolocalização.', true); return; }
    if (!window.isSecureContext) { avisar('GPS exige HTTPS ou localhost. Use Live Server no VS Code.', true); return; }
    carregando(ui.btnGpsOrigem, true, 'GPS...');
    navigator.geolocation.getCurrentPosition(pos => {
        origem = { endereco: 'Localização GPS (origem)', lat: pos.coords.latitude, lon: pos.coords.longitude, personalizado: true };
        ui.inputOrigem.value = origem.endereco;
        ui.labelOrigem.textContent = 'Origem pelo GPS';
        carregando(ui.btnGpsOrigem, false);
        renderizar();
        avisar(`Origem definida pelo GPS (precisão informada: ±${Math.round(pos.coords.accuracy)} m).`);
    }, erro => {
        carregando(ui.btnGpsOrigem, false);
        avisar(mensagemGPS(erro), true);
    }, { enableHighAccuracy:true, timeout:15000, maximumAge:5000 });
});

// ----------------------- ROTA E ENTREGAS -----------------------
function renderizar() {
    const concluidas = paradas.filter(p => p.concluida).length;
    const pendentes = paradas.length - concluidas;
    const percentual = paradas.length ? Math.round(concluidas / paradas.length * 100) : 0;
    ui.metricTotal.textContent = String(paradas.length).padStart(2, '0');
    ui.metricPendentes.textContent = String(pendentes).padStart(2, '0');
    ui.metricConcluidas.textContent = String(concluidas).padStart(2, '0');
    ui.metricProgress.textContent = `${percentual}%`;
    ui.progressBar.style.width = `${percentual}%`;
    ui.progressTrack.setAttribute('aria-valuenow', String(percentual));

    ui.contador.textContent = `${paradas.length} ${paradas.length === 1 ? 'parada' : 'paradas'}`;
    ui.resumo.textContent = paradas.length
        ? `${pendentes} pendente${pendentes !== 1 ? 's' : ''} · ${concluidas} concluída${concluidas !== 1 ? 's' : ''}`
        : 'Sua lista está pronta para começar.';

    ui.routeState.className = `route-state ${rotaIniciada && pendentes ? 'is-active' : rotaIniciada && !pendentes && paradas.length ? 'is-complete' : ''}`;
    ui.routeState.innerHTML = `<i></i> ${rotaIniciada && pendentes ? 'Em andamento' : rotaIniciada && paradas.length ? 'Finalizada' : 'Não iniciada'}`;
    if (rotaIniciada && pendentes) {
        ui.btnComecar.innerHTML = '<i class="fa-solid fa-check"></i> Rota em andamento';
    } else if (rotaIniciada && paradas.length) {
        ui.btnComecar.innerHTML = '<i class="fa-solid fa-flag-checkered"></i> Rota concluída';
    } else {
        ui.btnComecar.innerHTML = '<i class="fa-solid fa-play"></i> Começar rota';
    }

    ui.lista.replaceChildren();
    if (!paradas.length) {
        const vazio = document.createElement('div');
        vazio.className = 'empty-state';
        vazio.innerHTML = '<i class="fa-solid fa-box-open" aria-hidden="true"></i>Seu próximo destino começa aqui.<br>Adicione um endereço para montar a rota.';
        ui.lista.append(vazio);
    }
    const proxima = paradas.find(p => !p.concluida);
    paradas.forEach((p, indice) => {
        const item = document.createElement('article');
        item.className = `stop-item ${p.concluida ? 'concluida' : ''} ${rotaIniciada && proxima?.id === p.id ? 'ativa' : ''}`;

        const topo = document.createElement('div');
        topo.className = 'stop-item-head';
        const info = document.createElement('div');
        info.className = 'stop-item-info';
        const num = document.createElement('span');
        num.className = 'stop-item-num';
        num.textContent = String(indice + 1).padStart(2, '0');
        const bloco = document.createElement('div');
        bloco.style.minWidth = '0';
        const endereco = document.createElement('p');
        endereco.className = 'stop-item-address';
        endereco.textContent = p.endereco;
        const precisao = document.createElement('p');
        precisao.className = `stop-item-accuracy ${['confirmado', 'manual'].includes(p.precisao) ? 'is-confirmed' : ''}`;
        precisao.textContent = p.precisao === 'confirmado' ? '✓ Número identificado na base · confira no mapa' :
            p.precisao === 'manual' ? '✓ Ponto escolhido manualmente' :
            p.precisao === 'aproximado' ? '⚠ Localização aproximada · revise antes de navegar' :
            '⚠ Endereço antigo · posição não verificada';
        bloco.append(endereco, precisao);
        info.append(num, bloco);

        const excluir = document.createElement('button');
        excluir.type = 'button';
        excluir.className = 'stop-delete';
        excluir.title = 'Excluir parada';
        excluir.setAttribute('aria-label', `Excluir parada ${indice + 1}`);
        excluir.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
        excluir.addEventListener('click', () => {
            paradas = paradas.filter(item => item.id !== p.id);
            renderizar();
        });
        topo.append(info, excluir);

        const acoes = document.createElement('div');
        acoes.className = 'stop-actions';
        const navegar = document.createElement('a');
        navegar.href = enderecoMaps(p);
        navegar.target = '_blank';
        navegar.rel = 'noopener noreferrer';
        navegar.className = 'stop-action navigate';
        navegar.innerHTML = '<i class="fa-solid fa-location-arrow" aria-hidden="true"></i> Navegar';
        const concluir = document.createElement('button');
        concluir.type = 'button';
        concluir.className = `stop-action ${p.concluida ? 'undo' : 'complete'}`;
        concluir.innerHTML = p.concluida
            ? '<i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> Desfazer'
            : '<i class="fa-solid fa-check" aria-hidden="true"></i> Entregue';
        concluir.addEventListener('click', () => alternarConcluida(p.id));
        acoes.append(navegar, concluir);
        item.append(topo, acoes);
        ui.lista.append(item);
    });

    if (rotaIniciada && proxima) {
        ui.painel.classList.remove('hidden');
        ui.numeroProxima.textContent = String(paradas.findIndex(p => p.id === proxima.id) + 1).padStart(2, '0');
        ui.enderecoProxima.textContent = proxima.endereco;
        ui.progresso.textContent = `${concluidas} de ${paradas.length} concluídas`;
        ui.btnNavegar.href = enderecoMaps(proxima);
        ui.btnConcluir.onclick = () => alternarConcluida(proxima.id);
    } else ui.painel.classList.add('hidden');
    salvar();
    desenharMarcadores();
    desenharRota();
}
function alternarConcluida(id) {
    paradas = paradas.map(p => p.id === id ? { ...p, concluida: !p.concluida } : p);
    renderizar();
}
ui.btnComecar.addEventListener('click', () => {
    if (!paradas.some(p => !p.concluida)) { avisar('Adicione uma entrega pendente antes de começar.', true); return; }
    rotaIniciada = true; renderizar(); avisar('Rota iniciada. A próxima entrega está destacada.');
});
ui.btnResetar.addEventListener('click', () => {
    if (!confirm('Apagar todas as paradas desta rota? Esta ação não pode ser desfeita.')) return;
    paradas = []; rotaIniciada = false; renderizar(); avisar('Rota apagada.');
});
ui.btnLimpar.addEventListener('click', () => {
    const total = paradas.filter(p => p.concluida).length;
    if (!total) { avisar('Nenhuma parada concluída para remover.'); return; }
    paradas = paradas.filter(p => !p.concluida); renderizar(); avisar(`${total} entrega(s) concluída(s) removida(s).`);
});
function ordenarMaisPerto(pendentes, matriz) {
    let atual = 0;
    const indices = pendentes.map((_, index) => index + 1);
    const ordem = [];
    while (indices.length) {
        let melhor = 0, menor = Infinity;
        indices.forEach((indice, index) => {
            const valor = matriz[atual]?.[indice];
            if (Number.isFinite(valor) && valor < menor) { menor = valor; melhor = index; }
        });
        const [escolhido] = indices.splice(melhor, 1);
        ordem.push(pendentes[escolhido - 1]); atual = escolhido;
    }
    return ordem;
}
ui.btnOtimizar.addEventListener('click', async () => {
    const pendentes = paradas.filter(p => !p.concluida);
    if (!pendentes.length) { avisar('Não há paradas pendentes para otimizar.', true); return; }
    carregando(ui.btnOtimizar, true, 'Otimizando...');
    let ordenadas;
    try {
        if (pendentes.length + 1 > CONFIG.maxPontosOsrm) throw new Error('Limite de pontos do servidor');
        const partida = rotaIniciada && ultimaPosicaoGPS ? ultimaPosicaoGPS : origem;
        const coords = [partida, ...pendentes].map(p => `${p.lon},${p.lat}`).join(';');
        const resposta = await fetch(`${CONFIG.osrm}/table/v1/driving/${coords}?annotations=distance`);
        if (!resposta.ok) throw new Error(`OSRM respondeu HTTP ${resposta.status}`);
        const dados = await resposta.json();
        if (dados.code !== 'Ok' || !dados.distances) throw new Error('Matriz de ruas indisponível');
        ordenadas = ordenarMaisPerto(pendentes, dados.distances);
        avisar('Paradas reorganizadas pelas distâncias de rua (heurística; não garante rota ótima).');
    } catch (erro) {
        const copia = [...pendentes]; ordenadas = [];
        let atual = rotaIniciada && ultimaPosicaoGPS ? ultimaPosicaoGPS : origem;
        while (copia.length) {
            let melhor = 0;
            copia.forEach((p, i) => { if (distanciaMetros(atual, p) < distanciaMetros(atual, copia[melhor])) melhor = i; });
            const [proximo] = copia.splice(melhor, 1);
            ordenadas.push(proximo); atual = proximo;
        }
        avisar('Serviço de ruas indisponível. Ordem calculada por distância geográfica aproximada.');
        console.warn('Fallback de otimização:', erro);
    } finally { carregando(ui.btnOtimizar, false); }
    // Preserva posições e histórico de entregas já concluídas.
    let i = 0;
    paradas = paradas.map(p => p.concluida ? p : ordenadas[i++]);
    renderizar();
});
ui.btnAjustar.addEventListener('click', enquadrar);

// ---------------------- GPS EM TEMPO REAL ----------------------
// watchPosition coleta a melhor posição disponível; interface aplica atualizações a cada 5 segundos.
// O navegador não garante um novo fix a cada intervalo (especialmente em segundo plano).
function mensagemGPS(erro) {
    return ({
        1:'Permissão de GPS negada. Libere acesso à localização neste site.',
        2:'Localização indisponível. Ative o GPS do aparelho.',
        3:'Tempo limite do GPS excedido. Tente novamente.'
    })[erro.code] || 'Não foi possível obter sua localização.';
}
function poligonoPrecisao(lat, lon, raioMetros) {
    const raio = Math.max(1, Math.min(3000, raioMetros));
    const pontos = [];
    for (let i = 0; i <= 48; i++) {
        const ang = i / 48 * Math.PI * 2;
        const dLat = raio * Math.sin(ang) / 111320;
        const dLon = raio * Math.cos(ang) / (111320 * Math.max(.001, Math.cos(lat * Math.PI / 180)));
        pontos.push([lon + dLon, lat + dLat]);
    }
    return {type:'FeatureCollection', features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[pontos]}}]};
}
function atualizarGPSNaTela(force = false) {
    const p = ultimaPosicaoGPS;
    if (!p || !mapPronto || gpsWatchId === null) return;
    // Não cria um GPS falso: repinta a última coordenada efetivamente recebida do sistema.
    if (p.time !== instanteExibidoGPS || force) {
        instanteExibidoGPS = p.time;
        if (!marcadorGPS) {
            const elemento = document.createElement('div'); elemento.className = 'gps-ponto';
            marcadorGPS = new maplibregl.Marker({ element: elemento, anchor:'center' })
                .setLngLat([p.lon, p.lat])
                .setPopup(new maplibregl.Popup({offset:16}).setText('Sua localização GPS'))
                .addTo(mapa);
        } else marcadorGPS.setLngLat([p.lon, p.lat]);
        mapa.getSource('margem-gps')?.setData(poligonoPrecisao(p.lat, p.lon, p.accuracy));
        if (acompanharGPS) mapa.easeTo({ center:[p.lon,p.lat], zoom:Math.max(15, mapa.getZoom()), duration:650 });
    }
    const idade = Math.round((Date.now() - p.time) / 1000);
    ui.gpsStatus.classList.remove('hidden');
    ui.gpsStatus.textContent = idade > 15
        ? `GPS sem nova leitura há ${idade}s · última precisão ±${Math.round(p.accuracy)} m`
        : `GPS ao vivo · precisão ±${Math.round(p.accuracy)} m · leitura há ${idade}s`;
}
function pararGPS() {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    if (gpsTimer !== null) clearInterval(gpsTimer);
    gpsTimer = null;
    ultimaPosicaoGPS = null; instanteExibidoGPS = 0;
    if (marcadorGPS) marcadorGPS.remove();
    marcadorGPS = null;
    if (mapPronto) mapa.getSource('margem-gps')?.setData(areaVazia());
    ui.gpsStatus.classList.add('hidden');
    ui.btnCentralizarGps.classList.add('hidden');
    ui.btnGpsLive.setAttribute('aria-pressed', 'false');
    ui.btnGpsLive.innerHTML = '<span class="gps-mini-dot"></span><span><i class="fa-solid fa-satellite-dish"></i> GPS ao vivo</span>';
}
function iniciarGPS() {
    if (!navigator.geolocation) { avisar('Este navegador não suporta GPS.', true); return; }
    if (!window.isSecureContext) { avisar('GPS requer HTTPS ou localhost. Use Live Server no VS Code.', true); return; }
    acompanharGPS = true;
    ui.btnGpsLive.setAttribute('aria-pressed', 'true');
    ui.btnGpsLive.innerHTML = '<span class="gps-mini-dot"></span><span><i class="fa-solid fa-stop"></i> Parar GPS</span>';
    ui.btnCentralizarGps.classList.remove('hidden');
    ui.gpsStatus.classList.remove('hidden');
    ui.gpsStatus.textContent = 'Obtendo localização GPS...';
    gpsWatchId = navigator.geolocation.watchPosition(pos => {
        ultimaPosicaoGPS = { lat:pos.coords.latitude, lon:pos.coords.longitude,
            accuracy:pos.coords.accuracy, time:pos.timestamp || Date.now() };
        if (!instanteExibidoGPS) atualizarGPSNaTela(true);
    }, erro => {
        ui.gpsStatus.textContent = mensagemGPS(erro);
        if (erro.code === 1) { pararGPS(); avisar(mensagemGPS(erro), true); }
    }, { enableHighAccuracy:true, maximumAge:0, timeout:15000 });
    gpsTimer = setInterval(() => atualizarGPSNaTela(), CONFIG.intervaloGpsMs);
}
ui.btnGpsLive.addEventListener('click', () => {
    if (gpsWatchId === null) iniciarGPS(); else { pararGPS(); avisar('GPS ao vivo desativado.'); }
});
ui.btnCentralizarGps.addEventListener('click', () => {
    acompanharGPS = true;
    if (ultimaPosicaoGPS) atualizarGPSNaTela(true);
});
window.addEventListener('pagehide', () => { if (gpsWatchId !== null) pararGPS(); });

// ------------------------- OCR POR FOTO -------------------------
ui.btnCamera.addEventListener('click', () => ui.inputCamera.click());
ui.inputCamera.addEventListener('change', async evento => {
    const foto = evento.target.files?.[0];
    if (!foto) return;
    if (!foto.type.startsWith('image/')) { avisar('Selecione uma imagem válida.', true); return; }
    carregando(ui.btnCamera, true, 'Lendo imagem...');
    avisar('Reconhecendo texto da foto...');
    try {
        if (!window.Tesseract) throw new Error('Leitor de imagens indisponível. Verifique a conexão.');
        const resposta = await window.Tesseract.recognize(foto, 'por+eng');
        const texto = resposta.data.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(', ');
        if (!texto) throw new Error('Não foi possível identificar texto na foto.');
        ui.endereco.value = texto;
        fecharRevisao();
        ui.endereco.dispatchEvent(new Event('input'));
        avisar('Texto extraído. Confira rua, número e bairro antes de pesquisar.');
    } catch (erro) { avisar(erro.message, true); }
    finally { carregando(ui.btnCamera, false); ui.inputCamera.value = ''; }
});

// ------------------------ INICIALIZAÇÃO ------------------------
ui.inputOrigem.value = origem.personalizado ? origem.endereco : '';
ui.labelOrigem.textContent = origem.personalizado ? 'Origem definida' : 'Origem padrão';
if (origem.personalizado) ui.ajudaOrigem.textContent = 'Origem personalizada salva neste navegador.';
renderizar();
