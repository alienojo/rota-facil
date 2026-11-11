import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';

// RotaFácil 2026 — HTML/CSS/JS puro, sem Node.js ou compilação.
// Mapa: OpenFreeMap/MapLibre. Busca: Geoapify (opcional), Nominatim manual (testes).
const CONFIG = Object.freeze({
    mapStyle: 'https://tiles.openfreemap.org/styles/positron',
    nominatim: 'https://nominatim.openstreetmap.org',
    geoapify: 'https://api.geoapify.com/v1/geocode/search',
    osrm: 'https://router.project-osrm.org',
    intervaloGpsMs: 5000,
    maxPontosOsrm: 25,
    origemPadrao: { endereco: 'São José dos Campos, SP', lat: -23.1794, lon: -45.8869, personalizado: false }
});

const $ = id => document.getElementById(id);
const ui = {
    form: $('form-parada'), endereco: $('input-endereco'), resultados: $('resultados-endereco'),
    status: $('status-formulario'), btnAdicionar: $('btn-adicionar'), btnMarcar: $('btn-marcar-mapa'),
    lista: $('lista-entregas'), contador: $('contador-paradas'), resumo: $('resumo-entregas'),
    btnLimpar: $('btn-limpar'), btnOtimizar: $('btn-otimizar'), btnComecar: $('btn-comecar-rota'),
    btnResetar: $('btn-resetar-rota'), btnCamera: $('btn-camera'), inputCamera: $('input-file-camera'),
    inputOrigem: $('input-origem'), btnGpsOrigem: $('btn-gps-atual'), btnSalvarOrigem: $('btn-salvar-origem'),
    labelOrigem: $('label-status-origem'), ajudaOrigem: $('ajuda-origem'),
    painel: $('painel-bola-da-vez'), numeroProxima: $('numero-bola-da-vez'),
    enderecoProxima: $('endereco-bola-da-vez'), progresso: $('progresso-rota'),
    btnNavegar: $('btn-navegar-ativa'), btnConcluir: $('btn-concluir-ativa'),
    statusMapa: $('status-mapa'), mapaLoading: $('map-loading'), btnAjustar: $('btn-ajustar-mapa'),
    btnGpsLive: $('btn-gps-live'), btnCentralizarGps: $('btn-centralizar-gps'), gpsStatus: $('gps-status'),
    inputKey: $('input-api-key'), btnSalvarKey: $('btn-salvar-key'),
    metricTotal: $('metric-total'), metricPendentes: $('metric-pendentes'),
    metricConcluidas: $('metric-concluidas'), metricProgress: $('metric-progress'),
    progressBar: $('progress-bar'), progressTrack: $('progress-track'), routeState: $('route-state')
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
let enderecoPesquisado = '';
let escolhendoPonto = false;
let marcadorPrevia = null;
let marcadores = [];
let mapPronto = false;
let controladorRota = null;
let tokenRota = 0;
let filaNominatim = Promise.resolve();
let ultimoPedidoNominatim = 0;
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
    return `https://www.google.com/maps/dir/?api=1&destination=${parada.lat},${parada.lon}&travelmode=driving`;
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

// ---------------------- BUSCA DE ENDEREÇOS ----------------------
// NÃO consultar Nominatim no evento input: seu serviço público proíbe autocomplete.
function semAcentos(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\b(rua|r|avenida|av|travessa|tv)\b/g, '').replace(/[^a-z0-9]/g, ' ').trim().replace(/\s+/g, ' ');
}
function dadosEndereco(texto) {
    // Considera o último número de até 5 algarismos para não confundir "Rua 15 de Novembro" com o nº da casa.
    const ceps = [...texto.matchAll(/\b\d{5}-?\d{3}\b/g)]
        .map(m => [m.index, m.index + m[0].length]);
    const numeros = [...texto.matchAll(/\b\d{1,5}[A-Za-z]?\b/g)]
        .filter(m => !ceps.some(([inicio, fim]) => m.index >= inicio && m.index < fim));
    const candidato = numeros.at(-1);
    let rua = texto.trim();
    let numero = '';
    if (candidato) {
        numero = candidato[0];
        rua = texto.slice(0, candidato.index)
            .replace(/(?:n[ºo.]?|número)\s*$/i, '')
            .replace(/[\s,–—-]+$/, '').trim();
    }
    const resto = candidato ? texto.slice(candidato.index + candidato[0].length).replace(/^[\s,–—-]+/, '').trim() : '';
    return { rua: rua || texto.split(',')[0], numero, resto };
}
function enriquecerEndereco(texto) {
    const leitura = dadosEndereco(texto);
    // Insere separadores claros para reconhecer a rua, o número e o bairro, inclusive sem vírgulas.
    let consulta = leitura.numero
        ? `${leitura.rua}, ${leitura.numero}${leitura.resto ? `, ${leitura.resto}` : ''}`
        : texto.trim();
    consulta = consulta.replace(/[—–]/g, ',').replace(/,\s*,/g, ',');
    // A cidade padrão só é acrescentada a consultas sem uma indicação de cidade/UF.
    const cidadeConhecida = /s[aã]o jos[eé] dos campos|\bsjc\b|\b(?:sp|rj|mg|pr|sc|rs|es|ba|df|go|mt|ms|pe|ce|pb|rn|al|se|pi|ma|pa|am|ro|rr|ap|ac|to)\b/i.test(consulta);
    if (!cidadeConhecida && !/\b\d{5}-?\d{3}\b/.test(consulta)) {
        consulta += ', São José dos Campos, SP';
    }
    if (!/brasil|brazil/i.test(consulta)) consulta += ', Brasil';
    return consulta;
}
function limparResultados() {
    ui.resultados.classList.add('hidden');
    ui.resultados.replaceChildren();
    ui.btnMarcar.classList.add('hidden');
    enderecoPesquisado = '';
}
ui.endereco.addEventListener('input', () => {
    limparResultados();
    cancelarModoMapa();
});
function solicitarNominatim(url) {
    // Fila sequencial com no mínimo 1,1 s entre requisições deste navegador.
    const tarefa = filaNominatim.then(async () => {
        const espera = Math.max(0, 1100 - (Date.now() - ultimoPedidoNominatim));
        if (espera) await new Promise(resolve => setTimeout(resolve, espera));
        ultimoPedidoNominatim = Date.now();
        const resposta = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (!resposta.ok) throw new Error(`Busca OpenStreetMap indisponível (HTTP ${resposta.status}). Configure Geoapify.`);
        return resposta.json();
    });
    filaNominatim = tarefa.catch(() => {});
    return tarefa;
}
function resultadoCompativel(ruaBuscada, ruaResultado) {
    const a = semAcentos(ruaBuscada), b = semAcentos(ruaResultado);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}
async function buscarPeloGeoapify(texto, leitura) {
    const params = new URLSearchParams({
        text: enriquecerEndereco(texto), format: 'json', limit: '6', lang: 'pt',
        filter: 'countrycode:br', bias: `proximity:${origem.lon},${origem.lat}`, apiKey: geoapifyKey
    });
    const resposta = await fetch(`${CONFIG.geoapify}?${params}`);
    if (!resposta.ok) throw new Error(`Geoapify retornou HTTP ${resposta.status}. Confira a chave e o domínio autorizado.`);
    const json = await resposta.json();
    return (json.results || []).filter(p => valido(p.lat) && valido(p.lon))
        .filter(p => resultadoCompativel(leitura.rua, p.street || ''))
        .map(p => ({
            endereco: p.formatted || texto, lat: Number(p.lat), lon: Number(p.lon),
            numero: p.housenumber || '',
            exato: Boolean(leitura.numero && semAcentos(p.housenumber) === semAcentos(leitura.numero)
                && (p.result_type === 'building' || ['full_match', 'match_by_building'].includes(p.rank?.match_type))),
            fonte: 'Geoapify'
        }));
}
async function buscarPeloNominatim(texto, leitura) {
    const params = new URLSearchParams({ format:'json', addressdetails:'1', countrycodes:'br', limit:'6',
        q: enriquecerEndereco(texto) });
    let res = await solicitarNominatim(`${CONFIG.nominatim}/search?${params}`);
    // Se uma consulta com número não encontrou nada, procurar a rua (sem supor a numeração).
    if (!res.length && leitura.numero) {
        params.set('q', enriquecerEndereco(`${leitura.rua}, ${leitura.resto}`));
        res = await solicitarNominatim(`${CONFIG.nominatim}/search?${params}`);
    }
    return res.filter(p => valido(p.lat) && valido(p.lon))
        .filter(p => resultadoCompativel(leitura.rua, p.address?.road || p.address?.pedestrian || ''))
        .map(p => ({
            endereco: p.display_name, lat: Number(p.lat), lon: Number(p.lon),
            numero: p.address?.house_number || '',
            exato: Boolean(leitura.numero && semAcentos(p.address?.house_number) === semAcentos(leitura.numero)),
            fonte: 'OpenStreetMap'
        }));
}
async function buscarEndereco(texto) {
    const leitura = dadosEndereco(texto);
    if (!leitura.rua || leitura.rua.length < 3) throw new Error('Digite o nome da rua, número e bairro.');
    const dados = geoapifyKey
        ? await buscarPeloGeoapify(texto, leitura)
        : await buscarPeloNominatim(texto, leitura);
    return { leitura, dados: dados.slice(0, 5) };
}
function mostrarResultados(texto, busca) {
    const { leitura, dados } = busca;
    enderecoPesquisado = texto;
    ui.resultados.replaceChildren();
    ui.resultados.classList.remove('hidden');
    ui.btnMarcar.classList.remove('hidden');
    const cabecalho = document.createElement('p');
    cabecalho.className = 'resultado-cabecalho';
    cabecalho.textContent = dados.length
        ? 'Escolha o endereço correto. Verifique principalmente o número:'
        : 'Não encontramos uma rua compatível. Marque o ponto manualmente no mapa.';
    ui.resultados.append(cabecalho);
    dados.forEach(dado => {
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.className = 'resultado-endereco';
        const texto = document.createElement('div');
        texto.className = 'resultado-titulo';
        texto.textContent = dado.endereco;
        const detalhe = document.createElement('div');
        detalhe.className = `resultado-detalhe ${dado.exato ? 'badge-exato' : 'badge-aprox'}`;
        detalhe.textContent = dado.exato
            ? `✓ Número ${leitura.numero} identificado (${dado.fonte}). Conferir no mapa.`
            : `⚠ ${leitura.numero ? `Número ${leitura.numero} NÃO confirmado` : 'Sem número informado'} — ponto aproximado (${dado.fonte}).`;
        botao.append(texto, detalhe);
        botao.addEventListener('click', () => {
            if (!dado.exato && leitura.numero && !confirm(
                `ATENÇÃO: o número ${leitura.numero} NÃO foi confirmado.\n\nDeseja salvar um ponto APROXIMADO?\n\nPara maior precisão, cancele e use "Marcar ponto manualmente no mapa".`)) return;
            adicionarParada(textoDoUsuario(), dado.lat, dado.lon, dado.exato ? 'confirmado' : 'aproximado');
        });
        ui.resultados.append(botao);
    });
    if (dados.length && !dados.some(p => p.exato) && leitura.numero) {
        const dica = document.createElement('p');
        dica.className = 'resultado-alerta';
        dica.textContent = 'A busca localizou a rua, mas não confirmou o imóvel. Use o botão de marcar manualmente para evitar o ponto errado.';
        ui.resultados.append(dica);
    }
    if (mapa && dados.length) mapa.flyTo({ center:[dados[0].lon,dados[0].lat], zoom:16, duration:700 });
}
function textoDoUsuario() { return (enderecoPesquisado || ui.endereco.value).trim(); }
function adicionarParada(endereco, lat, lon, precisao) {
    paradas.push({ id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, endereco, lat, lon,
        concluida: false, precisao });
    ui.endereco.value = '';
    limparResultados();
    cancelarModoMapa();
    avisar(precisao === 'confirmado' ? 'Parada adicionada com número identificado.'
        : precisao === 'manual' ? 'Parada adicionada no ponto escolhido por você.'
        : 'Parada adicionada como aproximada. Confira antes de navegar.');
    renderizar();
}
ui.form.addEventListener('submit', async evento => {
    evento.preventDefault();
    const texto = ui.endereco.value.trim();
    if (texto.length < 4) return;
    carregando(ui.btnAdicionar, true, 'Buscando...');
    limparResultados();
    avisar('Pesquisando endereço e número...');
    try {
        const busca = await buscarEndereco(texto);
        // Evita apresentar respostas antigas se o texto foi alterado durante a requisição.
        if (ui.endereco.value.trim() !== texto) return;
        mostrarResultados(texto, busca);
        avisar(busca.dados.length ? 'Escolha uma opção abaixo ou marque o ponto no mapa.'
            : 'Nenhum endereço compatível. Use a marcação manual no mapa.', !busca.dados.length);
    } catch (erro) {
        enderecoPesquisado = texto;
        ui.btnMarcar.classList.remove('hidden');
        avisar(erro.message || 'Falha na busca. Tente novamente.', true);
    } finally { carregando(ui.btnAdicionar, false); }
});
function cancelarModoMapa() {
    escolhendoPonto = false;
    document.body.classList.remove('modo-marcar-mapa');
    if (marcadorPrevia) marcadorPrevia.remove();
    marcadorPrevia = null;
}
ui.btnMarcar.addEventListener('click', () => {
    if (!textoDoUsuario()) { avisar('Digite o endereço antes de marcar no mapa.', true); return; }
    escolhendoPonto = true;
    document.body.classList.add('modo-marcar-mapa');
    avisar('Toque/clique no imóvel correto no mapa para posicionar a entrega.');
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
function escolherCoordenadasManuais(lat, lon) {
    cancelarModoMapa();
    if (mapa) {
        marcadorPrevia = new maplibregl.Marker({ element: criarPin('✓', 'manual'), anchor:'center' })
            .setLngLat([lon,lat]).addTo(mapa);
    }
    const endereco = textoDoUsuario();
    if (confirm(`Usar este ponto para a entrega?\n\n${endereco}\n\nLatitude: ${lat.toFixed(6)}\nLongitude: ${lon.toFixed(6)}`)) {
        adicionarParada(endereco, lat, lon, 'manual');
    } else if (marcadorPrevia) { marcadorPrevia.remove(); marcadorPrevia = null; }
}
ui.inputKey.value = geoapifyKey;
ui.btnSalvarKey.addEventListener('click', () => {
    geoapifyKey = ui.inputKey.value.trim();
    try { localStorage.setItem(KEYS.geoapify, JSON.stringify(geoapifyKey)); }
    catch { avisar('Não foi possível salvar a chave.', true); return; }
    avisar(geoapifyKey ? 'Chave Geoapify salva. Faça uma nova busca.' : 'Chave removida. Busca manual limitada ativada.');
});

// ------------------------- ORIGEM -------------------------
async function salvarOrigemDigitada() {
    const texto = ui.inputOrigem.value.trim();
    if (!texto) { avisar('Digite um endereço de origem.', true); return; }
    carregando(ui.btnSalvarOrigem, true, 'Buscando...');
    try {
        const busca = await buscarEndereco(texto);
        const melhor = busca.dados.find(d => d.exato) || busca.dados[0];
        if (!melhor) throw new Error('Origem não localizada. Use GPS ou confira o endereço.');
        if (!melhor.exato && busca.leitura.numero && !confirm('O número da origem não foi confirmado. Usar localização aproximada?')) return;
        origem = { endereco:texto, lat:melhor.lat, lon:melhor.lon, personalizado:true };
        ui.labelOrigem.textContent = 'Origem definida';
        renderizar();
        avisar('Origem atualizada.');
    } catch (erro) { avisar(erro.message, true); }
    finally { carregando(ui.btnSalvarOrigem, false); }
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
    ui.routeState.innerHTML = `<span></span> ${rotaIniciada && pendentes ? 'Em andamento' : rotaIniciada && paradas.length ? 'Finalizada' : 'Não iniciada'}`;
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
        limparResultados();
        avisar('Texto extraído. Confira rua, número e bairro antes de pesquisar.');
    } catch (erro) { avisar(erro.message, true); }
    finally { carregando(ui.btnCamera, false); ui.inputCamera.value = ''; }
});

// ------------------------ INICIALIZAÇÃO ------------------------
ui.inputOrigem.value = origem.personalizado ? origem.endereco : '';
ui.labelOrigem.textContent = origem.personalizado ? 'Origem definida' : 'Origem padrão';
if (origem.personalizado) ui.ajudaOrigem.textContent = 'Origem personalizada salva neste navegador.';
renderizar();
