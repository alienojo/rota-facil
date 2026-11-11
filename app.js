import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';

/**
 * RotaFácil V5 — interface simples, geocodificação conservadora e otimização sob demanda.
 * Serviços públicos são configurados aqui; o usuário final não precisa configurar nada.
 * Para operação comercial em escala, use serviços com contrato/servidor próprios.
 */
const CONFIG = Object.freeze({
  mapStyle: 'https://tiles.openfreemap.org/styles/positron',
  photon: 'https://photon.komoot.io',
  osrm: 'https://router.project-osrm.org',
  sugestaoDelay: 750,
  intervaloMinBusca: 1100,
  intervaloGPS: 5000,
  maxPontosRoteamento: 24,
  cidadePadrao: 'São José dos Campos',
  ufPadrao: 'SP',
  origemPadrao: { endereco: 'Centro de São José dos Campos, SP (aproximado)', lat: -23.1794, lon: -45.8869, personalizado: false }
});
const $ = id => document.getElementById(id);
const ui = {
  form: $('form-parada'), endereco: $('input-endereco'), sugestoes: $('sugestoes-endereco'),
  searchSpinner: $('search-spinner'), status: $('status-formulario'), btnAdicionar: $('btn-adicionar'),
  revisao: $('revisao-endereco'), formRevisao: $('form-revisao'), btnFecharRevisao: $('btn-fechar-revisao'),
  reviewRua: $('review-rua'), reviewNumero: $('review-numero'), reviewBairro: $('review-bairro'),
  reviewCidade: $('review-cidade'), reviewUf: $('review-uf'), reviewCep: $('review-cep'),
  btnConfirmar: $('btn-confirmar-endereco'), btnEditar: $('btn-editar-endereco'),
  btnMarcar: $('btn-marcar-mapa'), btnSalvarAprox: $('btn-salvar-aproximado'),
  precisao: $('resultado-precisao'), aproxAcoes: $('aproximacao-acoes'),
  lista: $('lista-entregas'), contador: $('contador-paradas'), resumo: $('resumo-entregas'),
  btnLimpar: $('btn-limpar'), btnOtimizar: $('btn-otimizar'), btnComecar: $('btn-comecar-rota'),
  btnResetar: $('btn-resetar-rota'), btnCamera: $('btn-camera'), inputCamera: $('input-file-camera'),
  inputOrigem: $('input-origem'), btnGpsOrigem: $('btn-gps-atual'), btnSalvarOrigem: $('btn-salvar-origem'),
  labelOrigem: $('label-status-origem'), ajudaOrigem: $('ajuda-origem'),
  painel: $('painel-bola-da-vez'), numeroProxima: $('numero-bola-da-vez'), enderecoProxima: $('endereco-bola-da-vez'),
  progresso: $('progresso-rota'), btnNavegar: $('btn-navegar-ativa'), btnConcluir: $('btn-concluir-ativa'),
  statusMapa: $('status-mapa'), mapaLoading: $('map-loading'), mapHint: $('map-hint'), btnAjustar: $('btn-ajustar-mapa'),
  btnGpsLive: $('btn-gps-live'), btnCentralizarGps: $('btn-centralizar-gps'), gpsStatus: $('gps-status'),
  metricTotal: $('metric-total'), metricPendentes: $('metric-pendentes'),
  metricConcluidas: $('metric-concluidas'), metricProgress: $('metric-progress'),
  progressBar: $('progress-bar'), progressTrack: $('progress-track'), routeState: $('route-state'),
  heroStatus: $('hero-status'), heroDistancia: $('hero-distancia'), heroTempo: $('hero-tempo'),
  heroPendentes: $('hero-pendentes'), optimizationMessage: $('optimization-message')
};
const KEYS = {
  paradas: 'rotafacil_paradas',
  origem: 'rotafacil_origem',
  iniciada: 'rotafacil_iniciada',
  planejamento: 'rotafacil_v5_planejamento'
};
function ler(chave, fallback) {
  try { const v = localStorage.getItem(chave); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
const coordenadasValidas = p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) &&
  Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180;
function normalizarParadas(valor) {
  return Array.isArray(valor) ? valor.filter(p => p && coordenadasValidas(p) && typeof p.endereco === 'string')
    .map(p => ({ id: String(p.id || `${Date.now()}-${Math.random()}`), endereco: p.endereco,
      lat: Number(p.lat), lon: Number(p.lon), concluida: Boolean(p.concluida),
      precisao: p.precisao || 'legado', campos: p.campos || null })) : [];
}
let origem = ler(KEYS.origem, { ...CONFIG.origemPadrao });
if (!coordenadasValidas(origem)) origem = { ...CONFIG.origemPadrao };
let paradas = normalizarParadas(ler(KEYS.paradas, []));
let rotaIniciada = Boolean(ler(KEYS.iniciada, false));
let planejamento = ler(KEYS.planejamento, null);
let mapPronto = false, mapa, marcadores = [], marcadorPrevia = null, marcadorGPS = null;
let gpsWatchId = null, gpsTimer = null, ultimaPosicaoGPS = null, instanteExibidoGPS = 0, acompanharGPS = false;
let mapaEmSelecao = false, localManual = null, aproximadoPendente = null, idEmEdicao = null;
let debounceBusca = null, buscaController = null, buscaSequencia = 0;
let sugestoesAtuais = [], sugestaoDestacada = -1, textoOriginalBusca = '';
let filaBusca = Promise.resolve(), ultimaChamadaPhoton = 0;
let ultimoErroMapa = false, tokenDesenho = 0;
const cacheBusca = new Map();

function chaveDaRota() {
  // Uma edição de endereço/origem invalida o plano, mas concluir uma entrega não.
  return JSON.stringify({ origem: [origem.lat, origem.lon],
    paradas: paradas.map(p => [p.id, p.lat, p.lon]) });
}
function rotaOtimizada() {
  return Boolean(planejamento && planejamento.chave === chaveDaRota() && Array.isArray(planejamento.coordenadas));
}
if (!rotaOtimizada()) { planejamento = null; rotaIniciada = false; }
function salvar() {
  try {
    localStorage.setItem(KEYS.paradas, JSON.stringify(paradas));
    localStorage.setItem(KEYS.origem, JSON.stringify(origem));
    localStorage.setItem(KEYS.iniciada, JSON.stringify(rotaIniciada));
    if (planejamento) localStorage.setItem(KEYS.planejamento, JSON.stringify(planejamento));
    else localStorage.removeItem(KEYS.planejamento);
  } catch (e) { console.error('Falha ao salvar dados:', e); aviso('Não foi possível salvar seus dados neste navegador.', true); }
}
function aviso(msg, erro = false) {
  ui.status.textContent = msg;
  ui.status.className = `form-message${erro ? ' is-error' : ''}`;
}
function statusPlano(msg, tipo = 'normal') {
  ui.optimizationMessage.textContent = msg;
  ui.optimizationMessage.className = `hero-note ${tipo === 'ok' ? 'is-ok' : tipo === 'alerta' ? 'is-alert' : ''}`;
}
function busy(btn, ativo, texto) {
  if (ativo) { if (!btn.dataset.original) btn.dataset.original = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${texto}`; }
  else if (btn.dataset.original) { btn.innerHTML = btn.dataset.original; delete btn.dataset.original; }
  btn.disabled = ativo;
}
function htmlSeguro(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function normalizar(txt) { return String(txt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(rua|avenida|av|travessa|alameda|estrada|rodovia)\.?\s+/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function mesmaRua(a,b) { const x=normalizar(a), y=normalizar(b); return !!(x && y && (x===y || (x.length>=6 && y.includes(x)) || (y.length>=6 && x.includes(y)))); }
function mesmoNumero(a,b) { return String(a||'').trim().toLowerCase() !== '' && String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase(); }
function distanciaMetros(a,b) { const rad=Math.PI/180, dy=(b.lat-a.lat)*rad, dx=(b.lon-a.lon)*rad;
  const h=Math.sin(dy/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dx/2)**2;
  return 12742000*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h))); }
function urlNavegacao(p) {
  const dest = p.precisao === 'aproximado' ? encodeURIComponent(p.endereco.replaceAll(' — ', ', ')) : `${p.lat},${p.lon}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}
function invalidarPlano() {
  planejamento = null;
  rotaIniciada = false;
  atualizarLinha();
}

// ---------- MAPA: PONTOS DESDE O CADASTRO; LINHA APENAS DEPOIS DA OTIMIZAÇÃO ----------
try {
  mapa = new maplibregl.Map({ container: 'map', style: CONFIG.mapStyle,
    center: [Number(origem.lon), Number(origem.lat)], zoom: 13, attributionControl: true });
  mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  mapa.on('load', () => {
    mapPronto = true;
    mapa.addSource('percurso', { type: 'geojson', data: linhaVazia() });
    mapa.addLayer({ id: 'percurso-tracado', type: 'line', source: 'percurso',
      layout: { 'line-cap':'round', 'line-join':'round' },
      paint: { 'line-color':'#1c8b70', 'line-width':5, 'line-opacity': .94,
        'line-dasharray':[1,0.08] } });
    mapa.addSource('gps-area', { type:'geojson', data: linhaVazia() });
    mapa.addLayer({ id:'gps-previsao',type:'fill',source:'gps-area',
      paint:{ 'fill-color':'#2c89e8', 'fill-opacity':.13 } },'percurso-tracado');
    mapa.addLayer({ id:'gps-previsao-contorno',type:'line',source:'gps-area',
      paint:{ 'line-color':'#2c89e8', 'line-opacity':.55, 'line-width':1.4 } },'percurso-tracado');
    desenharMarcadores(); atualizarLinha(); enquadrar();
    if (ultimaPosicaoGPS) atualizarGPS(true);
  });
  mapa.on('error', e => {
    console.warn('Mapa:', e.error);
    if (!mapPronto && !ultimoErroMapa) { ultimoErroMapa = true; ui.statusMapa.textContent = 'O mapa não carregou. Confira sua conexão e tente atualizar a página.'; }
  });
  mapa.on('dragstart', () => { acompanharGPS = false; });
  mapa.on('click', e => { if (mapaEmSelecao) escolherPonto(e.lngLat.lat, e.lngLat.lng); });
} catch(e) { console.error('Mapa indisponível:', e); ui.statusMapa.textContent='Não foi possível abrir o mapa neste aparelho.'; }
function linhaVazia() { return { type:'FeatureCollection', features:[] }; }
function definirLinha(coords, aproximada) {
  if (!mapPronto) return;
  mapa.getSource('percurso')?.setData(coords.length >= 2
    ? { type:'Feature',properties:{},geometry:{type:'LineString',coordinates:coords} } : linhaVazia());
  mapa.setPaintProperty('percurso-tracado','line-dasharray',aproximada ? [1,2] : [1,0.08]);
}
function atualizarLinha() {
  if (!mapPronto) return;
  definirLinha(rotaOtimizada() ? planejamento.coordenadas : [], Boolean(planejamento?.linhaAproximada));
}
function criarPin(texto, tipo) {
  const el = document.createElement('div'); el.className=`map-pin ${tipo}`;
  el.textContent=String(texto); return el;
}
function desenharMarcadores() {
  if (!mapPronto) return;
  marcadores.forEach(m => m.remove()); marcadores=[];
  const inicio = new maplibregl.Marker({ element:criarPin('⌂','origem'),anchor:'center' })
    .setLngLat([origem.lon,origem.lat])
    .setPopup(new maplibregl.Popup({offset:20}).setHTML(`<b>Ponto de partida</b><br>${htmlSeguro(origem.endereco)}`)).addTo(mapa);
  marcadores.push(inicio);
  const proxima = rotaIniciada ? paradas.find(p=>!p.concluida) : null;
  paradas.forEach((p,i) => {
    const tipo = p.concluida ? 'concluida' : (proxima?.id===p.id ? 'proxima' : 'parada');
    const pin = new maplibregl.Marker({ element:criarPin(i+1,tipo),anchor:'center' })
      .setLngLat([p.lon,p.lat]).setPopup(new maplibregl.Popup({offset:20})
        .setHTML(`<b>Parada ${i+1}</b><br>${htmlSeguro(p.endereco)}<br><small>${p.precisao==='manual'?'Localização marcada no mapa':p.precisao==='confirmado'?'Número encontrado':'Localização a conferir'}</small>`))
      .addTo(mapa);
    marcadores.push(pin);
  });
}
function enquadrar() {
  if (!mapa) return;
  const pts = [[Number(origem.lon),Number(origem.lat)],...paradas.map(p=>[p.lon,p.lat])];
  if (pts.length===1) mapa.easeTo({center:pts[0],zoom:14,duration:250});
  else { const bbox=new maplibregl.LngLatBounds(pts[0],pts[0]); pts.forEach(p=>bbox.extend(p));
    mapa.fitBounds(bbox,{padding:50,maxZoom:16,duration:400}); }
}
ui.btnAjustar.addEventListener('click',enquadrar);

// ---------- BUSCA DE ENDEREÇOS (sem campos ou segredos técnicos para o usuário) ----------
function interpretarEndereco(entrada) {
  const original=String(entrada||'').trim().replace(/[—–]/g,',').replace(/\s+/g,' ');
  const semCep=original.replace(/\b\d{5}-?\d{3}\b/g,'');
  let rua=semCep, numero='', complemento='';
  // Primeiro respeita a pontuação habitual: "Rua Exemplo, 264, Bairro".
  let achado=semCep.match(/^(.*?)[,;]\s*(?:n[º°.]?\s*|n[uú]mero\s*)?(\d{1,6}[a-z]?)\b\s*[,;]?\s*(.*)$/i);
  if (!achado) {
    // Sem vírgula, o último token numérico pode ser o número da casa.
    // Não confunde "Rua 7 de Setembro" com um imóvel.
    const numeros=[...semCep.matchAll(/\b\d{1,6}[a-z]?\b/gi)].filter(m =>
      !/^\s+de\b/i.test(semCep.slice(m.index+m[0].length)) || m.index > 10);
    const ultimo=numeros.at(-1);
    if (ultimo) {
      achado=[null,semCep.slice(0,ultimo.index),ultimo[0],semCep.slice(ultimo.index+ultimo[0].length)];
    }
  }
  if (achado) {
    rua=achado[1].trim().replace(/\b(?:n|nº|n°|numero|número)\.?$/i,'').replace(/[\s,;-]+$/,'');
    numero=achado[2]; complemento=achado[3].replace(/^[\s,;-]+/,'').trim();
  }
  const cidadeEncontrada=complemento.match(/(?:^|,|\s)(São José dos Campos|Jacareí|Caçapava|Taubaté|Pindamonhangaba)(?:\s*[,\/-]\s*(SP))?\s*$/i);
  let cidade=CONFIG.cidadePadrao, bairro=complemento;
  if (cidadeEncontrada) { cidade=cidadeEncontrada[1]; bairro=complemento.slice(0,cidadeEncontrada.index).replace(/[\s,;]+$/,'').trim(); }
  if (bairro.toUpperCase()==='SP') bairro='';
  return { rua:rua||original,numero,bairro,cidade,uf:'SP',cep:(original.match(/\b\d{5}-?\d{3}\b/)||[])[0]||'' };
}
function camposAtuais() {
  return {rua:ui.reviewRua.value.trim(), numero:ui.reviewNumero.value.trim(),
    bairro:ui.reviewBairro.value.trim(), cidade:ui.reviewCidade.value.trim(),
    uf:ui.reviewUf.value.trim().toUpperCase(), cep:ui.reviewCep.value.trim()};
}
function enderecoCompleto(c) {
  return [c.rua+(c.numero?`, ${c.numero}`:''),c.bairro,`${c.cidade} - ${c.uf}`,c.cep?`CEP ${c.cep}`:'']
    .filter(Boolean).join(' — ');
}
function pesquisaCompleta(c) { return [c.rua,c.numero,c.bairro,c.cidade,c.uf,'Brasil'].filter(Boolean).join(', '); }
const ESTADOS_BR = Object.freeze({
  acre:'AC', alagoas:'AL', amapa:'AP', amazonas:'AM', bahia:'BA', ceara:'CE',
  'distrito federal':'DF', 'espirito santo':'ES', goias:'GO', maranhao:'MA',
  'mato grosso':'MT', 'mato grosso do sul':'MS', 'minas gerais':'MG', para:'PA',
  paraiba:'PB', parana:'PR', pernambuco:'PE', piaui:'PI', 'rio de janeiro':'RJ',
  'rio grande do norte':'RN', 'rio grande do sul':'RS', rondonia:'RO', roraima:'RR',
  'santa catarina':'SC', 'sao paulo':'SP', sergipe:'SE', tocantins:'TO'
});
function obterUF(estado) {
  const nome=normalizar(estado);
  return nome.length===2 ? nome.toUpperCase() : ESTADOS_BR[nome]||'';
}
function tratarPhoton(feature) {
  const p=feature?.properties||{}, arr=feature?.geometry?.coordinates||[];
  const rua=p.street||(['street','house'].includes(p.type)?p.name:'');
  if (!rua || !Number.isFinite(arr[0]) || !Number.isFinite(arr[1])) return null;
  return {rua,numero:String(p.housenumber||''),bairro:p.district||p.locality||p.suburb||'',
    cidade:p.city||'',uf:obterUF(p.state),cep:p.postcode||'',lat:Number(arr[1]),lon:Number(arr[0])};
}
function pontuarCandidato(c,campos) {
  if (!mesmaRua(c.rua,campos.rua)) return -1000;
  const cidadeOk = !campos.cidade || !c.cidade || normalizar(c.cidade)===normalizar(campos.cidade);
  if (!cidadeOk) return -500;
  const bairroOk = !campos.bairro || !c.bairro || normalizar(c.bairro)===normalizar(campos.bairro);
  const numeroOk = !!(campos.numero && mesmoNumero(campos.numero,c.numero));
  return 30+(c.cidade?14:0)+(bairroOk?8:-12)+(numeroOk?36:0)+(c.numero&&!numeroOk?-12:0);
}
function ordenarResultados(lista,campos) {
  const visto=new Set();
  return lista.filter(Boolean).filter(c=> {
    const key=[normalizar(c.rua),normalizar(c.bairro),normalizar(c.cidade),c.numero,c.lat.toFixed(5),c.lon.toFixed(5)].join('|');
    if(visto.has(key)) return false; visto.add(key); return pontuarCandidato(c,campos)>-500;
  }).sort((a,b)=>pontuarCandidato(b,campos)-pontuarCandidato(a,campos)).slice(0,8);
}
async function photon(url, signal) {
  // Fila serial: não disparamos requisições de autocomplete a cada tecla.
  let resultado;
  const job = filaBusca.then(async () => {
    const espera=Math.max(0, CONFIG.intervaloMinBusca-(Date.now()-ultimaChamadaPhoton));
    if (espera) await new Promise(r=>setTimeout(r,espera));
    if (signal?.aborted) throw new DOMException('Busca cancelada','AbortError');
    ultimaChamadaPhoton=Date.now();
    const r=await fetch(url,{signal,headers:{Accept:'application/json'}});
    if(!r.ok) throw new Error('A pesquisa de endereços está temporariamente indisponível.');
    resultado=await r.json();
  });
  filaBusca=job.catch(()=>{});
  await job; return resultado;
}
async function pesquisarPhoton(texto,{signal,limite=10}={}) {
  const params=new URLSearchParams({q:texto,lang:'pt',limit:String(limite),lat:String(origem.lat),lon:String(origem.lon)});
  const dados=await photon(`${CONFIG.photon}/api/?${params}`,signal);
  return (dados.features||[]).map(tratarPhoton).filter(Boolean);
}
async function sugestoesBusca(termo,signal) {
  const campos=interpretarEndereco(termo);
  const cacheKey=normalizar(termo);
  if (cacheBusca.has(cacheKey)) return cacheBusca.get(cacheKey);
  let lista=await pesquisarPhoton(termo,{signal});
  let ordenados=ordenarResultados(lista,campos);
  if (!ordenados.length) {
    // Muitos provedores não indexam os números: procura a rua separadamente.
    lista=await pesquisarPhoton([campos.rua,campos.bairro,campos.cidade].filter(Boolean).join(' '),{signal});
    ordenados=ordenarResultados(lista,campos);
  }
  cacheBusca.set(cacheKey,ordenados);
  if (cacheBusca.size>50) cacheBusca.delete(cacheBusca.keys().next().value);
  return ordenados;
}
function fecharSugestoes() {
  ui.sugestoes.replaceChildren(); ui.sugestoes.classList.add('hidden');
  ui.endereco.setAttribute('aria-expanded','false'); ui.endereco.removeAttribute('aria-activedescendant');
  sugestaoDestacada=-1; sugestoesAtuais=[];
}
function cancelarBusca() {
  clearTimeout(debounceBusca);
  if(buscaController) buscaController.abort(); buscaController=null;
  buscaSequencia++;
  ui.searchSpinner.classList.add('hidden');
}
function mostrarSugestoes(termo,resultados) {
  fecharSugestoes(); sugestoesAtuais=resultados;
  if(!resultados.length) {
    const p=document.createElement('p');p.className='suggestion-empty';
    p.textContent='Não encontramos sugestões. Use “Buscar” para conferir o endereço manualmente.';
    ui.sugestoes.append(p);
  } else resultados.forEach((d,i)=>{
    const b=document.createElement('button');b.type='button';b.className='suggestion';
    b.setAttribute('role','option');b.id=`sugestao-${i}`;
    const ico=document.createElement('i');ico.className='fa-solid fa-location-dot';
    const bloco=document.createElement('span');
    const titulo=document.createElement('strong');
    const leitura=interpretarEndereco(termo);
    titulo.textContent=d.rua+(leitura.numero?`, ${leitura.numero}`:d.numero?`, ${d.numero}`:'');
    const sub=document.createElement('small');sub.textContent=[d.bairro,d.cidade,d.uf].filter(Boolean).join(' · ');
    bloco.append(titulo,sub);
    if(leitura.numero && !mesmoNumero(d.numero,leitura.numero)) {
      const em=document.createElement('em');em.textContent='Número ainda não confirmado';bloco.append(em);
    }
    b.append(ico,bloco);
    b.addEventListener('click',()=>{ textoOriginalBusca=termo; prepararRevisao(d); });
    ui.sugestoes.append(b);
  });
  ui.sugestoes.classList.remove('hidden'); ui.endereco.setAttribute('aria-expanded','true');
}
async function buscarSugestoes(termo) {
  const seq=++buscaSequencia;
  if(buscaController) buscaController.abort();
  buscaController=new AbortController();
  ui.searchSpinner.classList.remove('hidden');
  try {
    const resultados=await sugestoesBusca(termo,buscaController.signal);
    if(seq!==buscaSequencia || termo!==ui.endereco.value.trim())return;
    mostrarSugestoes(termo,resultados);
  } catch(e) {
    if(e.name!=='AbortError' && seq===buscaSequencia) {
      fecharSugestoes(); aviso('A busca automática não respondeu. Você pode preencher o endereço manualmente.',true);
    }
  } finally { if(seq===buscaSequencia)ui.searchSpinner.classList.add('hidden'); }
}
ui.endereco.addEventListener('input',()=>{
  cancelarBusca(); fecharSugestoes(); fecharRevisao();
  const termo=ui.endereco.value.trim();
  if(termo.length<4)return;
  debounceBusca=setTimeout(()=>buscarSugestoes(termo),CONFIG.sugestaoDelay);
});
ui.endereco.addEventListener('keydown',e=>{
  const botoes=[...ui.sugestoes.querySelectorAll('[role="option"]')];
  if(!botoes.length || ui.sugestoes.classList.contains('hidden'))return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp') {
    e.preventDefault();sugestaoDestacada=(sugestaoDestacada+(e.key==='ArrowDown'?1:-1)+botoes.length)%botoes.length;
    botoes.forEach((b,i)=>b.classList.toggle('is-focused',i===sugestaoDestacada));
    ui.endereco.setAttribute('aria-activedescendant',botoes[sugestaoDestacada].id);
  } else if(e.key==='Enter' && sugestaoDestacada>=0) {e.preventDefault();botoes[sugestaoDestacada].click();}
  else if(e.key==='Escape') fecharSugestoes();
});
document.addEventListener('click',e=>{if(!ui.endereco.closest('.search-area').contains(e.target))fecharSugestoes();});
ui.form.addEventListener('submit',e=>{
  e.preventDefault();const valor=ui.endereco.value.trim();if(valor.length<3)return;
  textoOriginalBusca=valor;
  // Busca é opcional: o usuário pode ir direto para conferência mesmo se o serviço falhar.
  if(sugestoesAtuais.length===1) prepararRevisao(sugestoesAtuais[0]);
  else prepararRevisao(null);
});

function precisão(tipo,msg) {
  ui.precisao.className=`accuracy-message ${tipo==='alerta'?'is-warning':tipo==='ok'?'is-success':''}`;
  ui.precisao.replaceChildren();
  const ic=document.createElement('i');ic.className=`fa-solid ${tipo==='ok'?'fa-circle-check':tipo==='alerta'?'fa-triangle-exclamation':'fa-circle-info'}`;
  const p=document.createElement('span');p.textContent=msg;ui.precisao.append(ic,p);
}
function cancelarPino() {
  mapaEmSelecao=false;document.body.classList.remove('modo-marcar-mapa');
  if(marcadorPrevia) marcadorPrevia.remove();marcadorPrevia=null;
  ui.mapHint.textContent='Os pinos aparecem quando você adiciona endereços.';
}
function fecharRevisao() {
  ui.revisao.classList.add('hidden');ui.aproxAcoes.classList.add('hidden');
  localManual=null;aproximadoPendente=null;idEmEdicao=null;cancelarPino();
}
function prepararRevisao(sugestao=null, paradaExistente=null) {
  cancelarBusca();fecharSugestoes();fecharRevisao();
  idEmEdicao=paradaExistente?.id||null;
  const digitado=paradaExistente?.campos||interpretarEndereco(textoOriginalBusca||ui.endereco.value);
  let bairroDigitado=digitado.bairro||'';
  // Quando a pessoa informa a cidade no final, não confundi-la com o bairro.
  if (sugestao?.cidade && bairroDigitado) {
    const cidadeNorm=normalizar(sugestao.cidade);
    const semEstado=bairroDigitado.replace(/(?:\s*[,/-]\s*|\s+)[A-Z]{2}\s*$/,'').trim();
    if(normalizar(semEstado)===cidadeNorm)bairroDigitado='';
    else if(normalizar(semEstado).endsWith(` ${cidadeNorm}`))
      bairroDigitado=semEstado.slice(0,-sugestao.cidade.length).replace(/[\s,/-]+$/,'');
  }
  const dado={rua:sugestao?.rua||digitado.rua,numero:digitado.numero||sugestao?.numero||'',
    bairro:bairroDigitado||sugestao?.bairro||'',cidade:sugestao?.cidade||digitado.cidade||CONFIG.cidadePadrao,
    uf:sugestao?.uf||digitado.uf||'SP',cep:digitado.cep||sugestao?.cep||''};
  for(const [chave,input] of Object.entries({rua:ui.reviewRua,numero:ui.reviewNumero,bairro:ui.reviewBairro,
    cidade:ui.reviewCidade,uf:ui.reviewUf,cep:ui.reviewCep}))input.value=dado[chave]||'';
  ui.revisao.classList.remove('hidden');
  ui.endereco.value=enderecoCompleto(dado);
  precisão('normal', idEmEdicao ? 'Confira as informações. Ao confirmar, vamos localizar o endereço novamente.'
    : 'Confira o endereço. Ao confirmar, vamos verificar o ponto no mapa.');
  ui.btnConfirmar.innerHTML=`<i class="fa-solid fa-check"></i> ${idEmEdicao?'Salvar alteração':'OK, confirmar'}`;
  ui.revisao.scrollIntoView({behavior:'smooth',block:'nearest'});
  if(sugestao&&mapa) mapa.flyTo({center:[sugestao.lon,sugestao.lat],zoom:16,duration:450});
}
// Ao confirmar, buscamos NOVAMENTE, inclusive se o número foi editado.
async function geocodificarRevisado(campos) {
  let resultados=[];
  try { resultados=await pesquisarPhoton(pesquisaCompleta(campos),{limite:12}); }
  catch(e) { console.warn('Consulta completa:',e); }
  let ordenados=ordenarResultados(resultados,campos);
  if(!ordenados.length || !ordenados.some(r=>mesmoNumero(r.numero,campos.numero))) {
    // Nova consulta da rua, sem inventar coordenadas para o número digitado.
    try {
      resultados=await pesquisarPhoton([campos.rua,campos.bairro,campos.cidade].filter(Boolean).join(' '),{limite:12});
      ordenados=ordenarResultados([...ordenados,...resultados],campos);
    } catch(e) { if(!ordenados.length)throw e; }
  }
  const melhor=ordenados[0];
  if(!melhor)return null;
  const cidadeOK=!melhor.cidade || normalizar(melhor.cidade)===normalizar(campos.cidade);
  const bairroOK=!campos.bairro||!melhor.bairro||normalizar(melhor.bairro)===normalizar(campos.bairro);
  const exato=Boolean(campos.numero&&mesmoNumero(campos.numero,melhor.numero)&&mesmaRua(campos.rua,melhor.rua)&&cidadeOK&&bairroOK);
  return {...melhor,exato};
}
function adicionarOuAtualizar(campos,lat,lon,precisao) {
  const endereco=enderecoCompleto(campos);
  if(idEmEdicao) {
    paradas=paradas.map(p=>p.id===idEmEdicao?{...p,endereco,lat,lon,precisao,campos}:p);
  } else {
    paradas.push({id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,endereco,
      lat,lon,precisao,campos,concluida:false});
  }
  const editando=!!idEmEdicao;
  ui.endereco.value='';textoOriginalBusca='';fecharRevisao();invalidarPlano();renderizar();
  aviso(editando?'Endereço atualizado. Otimize novamente a rota.':
    precisao==='aproximado'?'Parada adicionada como aproximada. Confira antes de navegar.':
    'Parada adicionada. Você pode continuar cadastrando os destinos.');
}
ui.formRevisao.addEventListener('submit',async e=>{
  e.preventDefault();const campos=camposAtuais();
  if(!campos.rua||!campos.cidade||!campos.uf){precisão('alerta','Preencha pelo menos rua, cidade e estado.');return;}
  if(localManual){adicionarOuAtualizar(campos,localManual.lat,localManual.lon,'manual');return;}
  busy(ui.btnConfirmar,true,'Localizando...');
  aproximadoPendente=null;ui.aproxAcoes.classList.add('hidden');
  precisão('normal','Conferindo a localização...');
  try {
    const p=await geocodificarRevisado(campos);
    if(!p){precisão('alerta','Não encontramos essa rua. Revise os dados ou marque o local no mapa.');return;}
    if(mapa)mapa.flyTo({center:[p.lon,p.lat],zoom:17,duration:550});
    if(p.exato) adicionarOuAtualizar(campos,p.lat,p.lon,'confirmado');
    else {
      aproximadoPendente={lat:p.lat,lon:p.lon,campos};
      ui.aproxAcoes.classList.remove('hidden');
      precisão('alerta',campos.numero
        ? `Encontramos a rua, mas não confirmamos o número ${campos.numero}. Marque o local no mapa ou salve como aproximado.`
        : 'Localizamos a rua, mas o ponto pode ser aproximado. Marque no mapa ou salve assim.');
    }
  }catch(e){precisão('alerta','Não conseguimos verificar o local agora. Tente de novo ou escolha o ponto no mapa.');}
  finally{busy(ui.btnConfirmar,false);}
});
ui.btnSalvarAprox.addEventListener('click',()=>{
  if(!aproximadoPendente)return;
  const {lat,lon,campos}=aproximadoPendente;adicionarOuAtualizar(campos,lat,lon,'aproximado');
});
ui.btnEditar.addEventListener('click',()=>{ui.reviewRua.focus();ui.reviewRua.select();});
ui.btnFecharRevisao.addEventListener('click',()=>{fecharRevisao();aviso('Conferência cancelada.');});
for(const input of [ui.reviewRua,ui.reviewNumero,ui.reviewBairro,ui.reviewCidade,ui.reviewUf,ui.reviewCep]){
  input.addEventListener('input',()=>{
    aproximadoPendente=null;localManual=null;ui.aproxAcoes.classList.add('hidden');cancelarPino();
    precisão('normal','Endereço alterado. Clique em OK para localizar novamente.');
  });
}
ui.btnMarcar.addEventListener('click',()=>{
  if(ui.revisao.classList.contains('hidden'))return;
  mapaEmSelecao=true;document.body.classList.add('modo-marcar-mapa');
  ui.mapHint.textContent='Clique ou toque no ponto desejado para marcar a entrega.';
  precisão('alerta','Toque no lugar certo no mapa. Depois volte e clique em OK.');
  $('mapa').scrollIntoView({behavior:'smooth',block:'start'});
});
function escolherPonto(lat,lon){
  cancelarPino();localManual={lat,lon};aproximadoPendente=null;
  ui.aproxAcoes.classList.add('hidden');
  if(mapa){const el=document.createElement('div');el.className='preview-pin';el.innerHTML='<i class="fa-solid fa-check"></i>';
    marcadorPrevia=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([lon,lat]).addTo(mapa);}
  precisão('ok','Local escolhido no mapa! Clique em OK para salvar a parada.');
  ui.revisao.scrollIntoView({behavior:'smooth',block:'center'});
}

// ---------- PARADAS E RESUMO ----------
function renderizar() {
  const feitas=paradas.filter(p=>p.concluida).length;
  const pendentes=paradas.length-feitas;
  const percentual=paradas.length?Math.round(feitas/paradas.length*100):0;
  const pronta=rotaOtimizada();
  ui.contador.textContent=`${paradas.length} ${paradas.length===1?'parada':'paradas'}`;
  ui.resumo.textContent=paradas.length
    ? `${pendentes} pendente${pendentes!==1?'s':''} · ${feitas} concluída${feitas!==1?'s':''}`
    : 'Nenhum endereço adicionado.';
  ui.metricTotal.textContent=String(paradas.length).padStart(2,'0');
  ui.metricPendentes.textContent=String(pendentes).padStart(2,'0');
  ui.metricConcluidas.textContent=String(feitas).padStart(2,'0');
  ui.metricProgress.textContent=`${percentual}%`;
  ui.progressBar.style.width=`${percentual}%`;
  ui.progressTrack.setAttribute('aria-valuenow',String(percentual));
  ui.heroPendentes.textContent=String(pendentes);
  ui.heroDistancia.textContent=pronta&&planejamento.km!=null?`${planejamento.km.toFixed(1).replace('.',',')} km`:'—';
  ui.heroTempo.textContent=pronta&&planejamento.min!=null
    ? planejamento.min>=60?`${Math.floor(planejamento.min/60)}h ${Math.round(planejamento.min%60)}min`:`${Math.round(planejamento.min)} min`
    :'—';
  ui.btnComecar.disabled=!pronta||!pendentes;
  ui.btnOtimizar.disabled=!pendentes;

  if(!paradas.length){
    ui.heroStatus.textContent='Pronto para planejar';
    ui.routeState.textContent='Em preparação';
    statusPlano('Adicione os endereços. O cálculo começa só quando você clicar em “Otimizar rota”.');
    ui.statusMapa.textContent='Adicione endereços para começar.';
    ui.mapHint.textContent='Os pinos aparecem quando você adiciona endereços.';
  } else if (!pronta) {
    ui.heroStatus.textContent='Aguardando otimização';
    ui.routeState.textContent='Falta otimizar';
    statusPlano(`${pendentes} ${pendentes===1?'destino cadastrado':'destinos cadastrados'}. Quando terminar, clique em “Otimizar rota”.`,'alerta');
    ui.statusMapa.textContent='Pontos cadastrados. O trajeto ainda não foi calculado.';
    ui.mapHint.textContent='Otimize para desenhar o percurso pelas ruas.';
  } else if(rotaIniciada) {
    ui.heroStatus.textContent=pendentes?'Rota em andamento':'Entregas concluídas';
    ui.routeState.textContent=pendentes?'Em andamento':'Concluída';
    statusPlano(pendentes?`Rota otimizada. Faltam ${pendentes} entrega${pendentes!==1?'s':''}.`:'Todas as entregas foram concluídas.','ok');
    ui.statusMapa.textContent=planejamento.linhaAproximada?'Sequência pronta. Desenho do trajeto é ilustrativo.':'Sequência otimizada · trajeto estimado.';
    ui.mapHint.textContent='Toque em um pino para ver o endereço.';
  } else {
    ui.heroStatus.textContent='Rota otimizada';
    ui.routeState.textContent='Pronta para sair';
    statusPlano(planejamento.modo==='ruas'
      ? 'Sequência organizada usando tempos estimados pelas ruas. Agora é só começar as entregas.'
      : 'Sequência organizada por proximidade aproximada. Confira o percurso antes de sair.','ok');
    ui.statusMapa.textContent=planejamento.linhaAproximada?'Ordem pronta. Linha no mapa ilustrativa.':'Percurso estimado desenhado no mapa.';
    ui.mapHint.textContent='Toque em um pino para ver o endereço.';
  }

  ui.lista.replaceChildren();
  if(!paradas.length){
    const div=document.createElement('div');div.className='empty-state';
    div.innerHTML='<i class="fa-solid fa-map-location-dot"></i><strong>Nenhuma entrega por aqui</strong><span>Digite seu primeiro endereço no campo acima.</span>';
    ui.lista.append(div);
  }
  const proxima=rotaIniciada?paradas.find(p=>!p.concluida):null;
  paradas.forEach((p,i)=>{
    const card=document.createElement('article');
    card.className=`stop-card${p.concluida?' done':''}${p.id===proxima?.id?' current':''}`;
    const header=document.createElement('div');header.className='stop-header';
    const numero=document.createElement('span');numero.className='stop-number';numero.textContent=String(i+1).padStart(2,'0');
    const texto=document.createElement('div');texto.className='stop-details';
    const nome=document.createElement('strong');nome.textContent=p.endereco;
    const detalhe=document.createElement('small');
    detalhe.textContent=p.concluida?'Entrega concluída':p.precisao==='aproximado'||p.precisao==='legado'
      ? 'Localização aproximada — confira antes de sair':p.precisao==='manual'?'Ponto escolhido no mapa':'Endereço cadastrado';
    texto.append(nome,detalhe);header.append(numero,texto);
    const acoes=document.createElement('div');acoes.className='stop-actions';
    const nav=document.createElement('a');nav.className='stop-action';nav.href=urlNavegacao(p);
    nav.target='_blank';nav.rel='noopener noreferrer';nav.innerHTML='<i class="fa-solid fa-location-arrow"></i> Navegar';
    const editar=document.createElement('button');editar.type='button';editar.className='stop-action';
    editar.innerHTML='<i class="fa-solid fa-pen"></i> Editar';
    editar.addEventListener('click',()=>{
      textoOriginalBusca=p.endereco;
      prepararRevisao(null,p);
      $('nova-entrega').scrollIntoView({behavior:'smooth',block:'start'});
    });
    const entregue=document.createElement('button');entregue.type='button';
    entregue.className='stop-action primary';
    entregue.innerHTML=p.concluida?'<i class="fa-solid fa-rotate-left"></i> Desfazer':'<i class="fa-solid fa-check"></i> Entregue';
    entregue.addEventListener('click',()=>alternarConcluida(p.id));
    const remover=document.createElement('button');remover.type='button';remover.className='stop-action delete';
    remover.setAttribute('aria-label',`Excluir parada ${i+1}`);remover.title='Excluir parada';
    remover.innerHTML='<i class="fa-solid fa-trash"></i>';
    remover.addEventListener('click',()=>{
      paradas=paradas.filter(item=>item.id!==p.id);invalidarPlano();renderizar();aviso('Parada excluída.');
    });
    acoes.append(nav,editar,entregue,remover);card.append(header,acoes);ui.lista.append(card);
  });
  if(rotaIniciada&&proxima){
    ui.painel.classList.remove('hidden');
    ui.numeroProxima.textContent=String(paradas.findIndex(p=>p.id===proxima.id)+1).padStart(2,'0');
    ui.enderecoProxima.textContent=proxima.endereco;
    ui.progresso.textContent=`${feitas} de ${paradas.length} concluídas`;
    ui.btnNavegar.href=urlNavegacao(proxima);
    ui.btnConcluir.onclick=()=>alternarConcluida(proxima.id);
  } else {ui.painel.classList.add('hidden');}
  salvar();desenharMarcadores();atualizarLinha();
}
function alternarConcluida(id) {
  paradas=paradas.map(p=>p.id===id?{...p,concluida:!p.concluida}:p);
  renderizar();
}
ui.btnComecar.addEventListener('click',()=>{
  if(!rotaOtimizada()){statusPlano('Primeiro, clique em “Otimizar rota”.','alerta');return;}
  if(!paradas.some(p=>!p.concluida))return;
  rotaIniciada=true;renderizar();
  $('mapa').scrollIntoView({behavior:'smooth',block:'start'});
});
ui.btnResetar.addEventListener('click',()=>{
  if(!confirm('Apagar todas as entregas desta rota? Essa ação não pode ser desfeita.'))return;
  paradas=[];invalidarPlano();renderizar();aviso('Pronto! Você pode cadastrar uma nova rota.');
});
ui.btnLimpar.addEventListener('click',()=>{
  if(!paradas.some(p=>p.concluida)){aviso('Nenhuma entrega concluída para remover.');return;}
  paradas=paradas.filter(p=>!p.concluida);invalidarPlano();renderizar();aviso('Entregas concluídas removidas.');
});

// ---------- OTIMIZAÇÃO: SÓ AO TOCAR NO BOTÃO ----------
function matrizGeografica(pontos) {
  return pontos.map(a=>pontos.map(b=>distanciaMetros(a,b)/11.1)); // segundos aproximados; apenas para ordenar
}
function custoSequencia(indices,matriz) {
  let soma=0, anterior=0;
  for(const atual of indices){
    const valor=matriz[anterior]?.[atual];
    if(!Number.isFinite(valor))return Infinity;
    soma+=valor;anterior=atual;
  }
  return soma;
}
function heuristicaCom2Opt(matriz) {
  // Caminho aberto: começa na origem (índice 0), não precisa retornar ao depósito.
  const restantes=Array.from({length:matriz.length-1},(_,i)=>i+1), ordem=[];
  let atual=0;
  while(restantes.length){
    let pos=0,menor=Infinity;
    restantes.forEach((i,k)=>{const d=matriz[atual][i];if(Number.isFinite(d)&&d<menor){menor=d;pos=k;}});
    const [escolhido]=restantes.splice(pos,1);ordem.push(escolhido);atual=escolhido;
  }
  let melhor=custoSequencia(ordem,matriz);
  // Testa reversões de trechos e só mantém melhorias. Considera ruas de mão única:
  // calcula o custo de toda a sequência, não usa a fórmula simétrica.
  for(let rodada=0;rodada<12;rodada++){
    let ganho=false;
    for(let i=0;i<ordem.length-1;i++)for(let j=i+1;j<ordem.length;j++){
      const candidata=[...ordem.slice(0,i),...ordem.slice(i,j+1).reverse(),...ordem.slice(j+1)];
      const custo=custoSequencia(candidata,matriz);
      if(custo+0.1<melhor){ordem.splice(0,ordem.length,...candidata);melhor=custo;ganho=true;}
    }
    if(!ganho)break;
  }
  return ordem;
}
async function buscarMatriz(pontos) {
  const coords=pontos.map(p=>`${p.lon},${p.lat}`).join(';');
  const url=`${CONFIG.osrm}/table/v1/driving/${coords}?annotations=duration`;
  const resposta=await fetch(url);
  if(!resposta.ok)throw new Error('Não foi possível consultar as ruas.');
  const data=await resposta.json();
  if(data.code!=='Ok'||!Array.isArray(data.durations)||data.durations.length!==pontos.length)
    throw new Error('Tempos de percurso indisponíveis.');
  // Paradas desconectadas da malha viária exigem fallback claramente indicado.
  if(data.durations.some(l=>!Array.isArray(l)||l.some(v=>!Number.isFinite(v))))
    throw new Error('Existem pontos sem ligação conhecida pelas ruas.');
  return data.durations;
}
async function buscarTrajeto(pontos) {
  const coords=pontos.map(p=>`${p.lon},${p.lat}`).join(';');
  const url=`${CONFIG.osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const resposta=await fetch(url);
  if(!resposta.ok)throw new Error('Trajeto indisponível');
  const data=await resposta.json();
  if(data.code!=='Ok'||!data.routes?.[0]?.geometry?.coordinates?.length) throw new Error('Trajeto não encontrado');
  return data.routes[0];
}
ui.btnOtimizar.addEventListener('click',async()=>{
  const pendentes=paradas.filter(p=>!p.concluida);
  if(!pendentes.length){statusPlano('Adicione ao menos uma entrega antes de otimizar.','alerta');return;}
  if(pendentes.length+1>CONFIG.maxPontosRoteamento){
    statusPlano(`Para evitar erros, otimize em grupos de até ${CONFIG.maxPontosRoteamento-1} entregas.`,'alerta');return;
  }
  const assinatura=chaveDaRota();
  const pontos=[origem,...pendentes];
  busy(ui.btnOtimizar,true,'Calculando...');
  ui.mapaLoading.classList.remove('hidden');
  statusPlano('Encontrando a melhor sequência disponível para seus endereços...');
  let matriz,modo='ruas',indices;
  try {
    try { matriz=await buscarMatriz(pontos); }
    catch(e) {console.warn('Matriz rodoviária:',e);matriz=matrizGeografica(pontos);modo='aproximado';}
    indices=heuristicaCom2Opt(matriz);
    if(chaveDaRota()!==assinatura)throw new Error('A lista foi alterada. Clique em otimizar novamente.');
    const novasPendentes=indices.map(i=>pendentes[i-1]);
    const pontosOrdenados=[origem,...novasPendentes];
    let geometria=pontosOrdenados.map(p=>[p.lon,p.lat]);
    let km=null,min=null,linhaAproximada=true;
    try {
      const rota=await buscarTrajeto(pontosOrdenados);
      geometria=rota.geometry.coordinates;
      km=rota.distance/1000;min=rota.duration/60;linhaAproximada=false;
    } catch(e) {console.warn('Traçado pelas ruas:',e);}
    if(chaveDaRota()!==assinatura)throw new Error('A lista mudou durante o cálculo. Otimize novamente.');
    let i=0;paradas=paradas.map(p=>p.concluida?p:novasPendentes[i++]);
    planejamento={chave:chaveDaRota(),coordenadas:geometria,km,min,linhaAproximada,modo};
    renderizar();
    if(modo==='aproximado'||linhaAproximada)
      statusPlano('Sequência calculada. Parte do percurso é aproximada; confira o mapa antes de sair.','alerta');
    else statusPlano('Pronto! Ordem otimizada por ruas. Você já pode começar as entregas.','ok');
    enquadrar();
  } catch(e) {
    console.warn('Otimização falhou:',e);
    statusPlano(e.message||'Não foi possível otimizar a rota agora.','alerta');
  } finally {
    busy(ui.btnOtimizar,false);
    ui.mapaLoading.classList.add('hidden');
  }
});

// ---------- PONTO DE PARTIDA ----------
async function salvarOrigemDigitada() {
  const texto=ui.inputOrigem.value.trim();
  if(!texto){aviso('Digite seu endereço de partida ou use o GPS.',true);return;}
  busy(ui.btnSalvarOrigem,true,'Localizando...');
  try {
    const leitura=interpretarEndereco(texto);
    const p=await geocodificarRevisado(leitura);
    if(!p)throw new Error('Não encontramos o ponto de partida. Confira rua e cidade ou use o GPS.');
    if(leitura.numero&&!p.exato&&!confirm('O número do ponto de partida não foi confirmado. Usar localização aproximada?'))return;
    origem={endereco:texto,lat:p.lat,lon:p.lon,personalizado:true};
    ui.labelOrigem.textContent='Origem definida';
    cacheBusca.clear();invalidarPlano();renderizar();enquadrar();
    aviso('Ponto de partida atualizado.');
  } catch(e){aviso(e.message||'Não foi possível localizar o ponto de partida.',true);}
  finally{busy(ui.btnSalvarOrigem,false);}
}
ui.btnSalvarOrigem.addEventListener('click',salvarOrigemDigitada);
ui.inputOrigem.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();salvarOrigemDigitada();}});
ui.btnGpsOrigem.addEventListener('click',()=>{
  if(!navigator.geolocation){aviso('O GPS não está disponível neste navegador.',true);return;}
  if(!window.isSecureContext){aviso('Para usar o GPS, abra o site por HTTPS ou localhost.',true);return;}
  busy(ui.btnGpsOrigem,true,'Localizando...');
  navigator.geolocation.getCurrentPosition(pos=>{
    origem={endereco:'Minha localização',lat:pos.coords.latitude,lon:pos.coords.longitude,personalizado:true};
    ui.inputOrigem.value=origem.endereco;ui.labelOrigem.textContent='Origem pelo GPS';
    cacheBusca.clear();invalidarPlano();renderizar();enquadrar();
    busy(ui.btnGpsOrigem,false);
    aviso(`Origem definida pelo GPS (precisão informada: ±${Math.round(pos.coords.accuracy)} m).`);
  },e=>{busy(ui.btnGpsOrigem,false);aviso(mensagemGPS(e),true);},
  {enableHighAccuracy:true,timeout:15000,maximumAge:5000});
});

// ---------- GPS AO VIVO (sem novas consultas de rota) ----------
function mensagemGPS(e) {return ({1:'Permissão de localização negada. Ative-a no navegador.',
  2:'Não foi possível determinar sua posição.',3:'GPS demorou demais. Tente novamente.'})[e?.code]||'GPS indisponível.';}
function areaGps(lat,lon,raio) {
  const r=Math.max(1,Math.min(3000,raio||10)),pts=[];
  for(let i=0;i<=48;i++){
    const a=i/48*Math.PI*2;
    pts.push([lon+r*Math.cos(a)/(111320*Math.max(.001,Math.cos(lat*Math.PI/180))),lat+r*Math.sin(a)/111320]);
  }
  return {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[pts]}}]};
}
function atualizarGPS(forcar=false) {
  const p=ultimaPosicaoGPS;
  if(!p||!mapPronto||gpsWatchId===null)return;
  if(p.time!==instanteExibidoGPS||forcar){
    instanteExibidoGPS=p.time;
    if(!marcadorGPS){
      const el=document.createElement('div');el.className='gps-ponto';
      marcadorGPS=new maplibregl.Marker({element:el,anchor:'center'})
        .setLngLat([p.lon,p.lat]).setPopup(new maplibregl.Popup({offset:16}).setText('Sua localização atual')).addTo(mapa);
    } else marcadorGPS.setLngLat([p.lon,p.lat]);
    mapa.getSource('gps-area')?.setData(areaGps(p.lat,p.lon,p.accuracy));
    if(acompanharGPS)mapa.easeTo({center:[p.lon,p.lat],zoom:Math.max(15,mapa.getZoom()),duration:500});
  }
  const segundos=Math.round((Date.now()-p.time)/1000);
  ui.gpsStatus.classList.remove('hidden');
  ui.gpsStatus.textContent=segundos>20
    ? `Último sinal do GPS há ${segundos}s · precisão ±${Math.round(p.accuracy)} m`
    : `GPS ativo · precisão ±${Math.round(p.accuracy)} m`;
}
function pararGPS() {
  if(gpsWatchId!==null)navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;
  if(gpsTimer!==null)clearInterval(gpsTimer);gpsTimer=null;
  ultimaPosicaoGPS=null;instanteExibidoGPS=0;
  if(marcadorGPS)marcadorGPS.remove();marcadorGPS=null;
  if(mapPronto)mapa.getSource('gps-area')?.setData(linhaVazia());
  ui.gpsStatus.classList.add('hidden');ui.btnCentralizarGps.classList.add('hidden');
  ui.btnGpsLive.setAttribute('aria-pressed','false');
  ui.btnGpsLive.innerHTML='<span class="gps-mini-dot"></span><span><i class="fa-solid fa-satellite-dish"></i> GPS ao vivo</span>';
}
function iniciarGPS() {
  if(!navigator.geolocation){aviso('Seu dispositivo não tem suporte a GPS.',true);return;}
  if(!window.isSecureContext){aviso('O GPS precisa de conexão HTTPS ou localhost.',true);return;}
  acompanharGPS=true;
  ui.btnGpsLive.setAttribute('aria-pressed','true');
  ui.btnGpsLive.innerHTML='<span class="gps-mini-dot"></span><span><i class="fa-solid fa-stop"></i> Parar GPS</span>';
  ui.btnCentralizarGps.classList.remove('hidden');
  ui.gpsStatus.classList.remove('hidden');ui.gpsStatus.textContent='Procurando sua localização...';
  gpsWatchId=navigator.geolocation.watchPosition(pos=>{
    ultimaPosicaoGPS={lat:pos.coords.latitude,lon:pos.coords.longitude,
      accuracy:pos.coords.accuracy,time:pos.timestamp||Date.now()};
    if(!instanteExibidoGPS)atualizarGPS(true);
  },e=>{
    ui.gpsStatus.textContent=mensagemGPS(e);
    if(e.code===1){pararGPS();aviso(mensagemGPS(e),true);}
  },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
  gpsTimer=setInterval(()=>atualizarGPS(),CONFIG.intervaloGPS);
}
ui.btnGpsLive.addEventListener('click',()=>gpsWatchId===null?iniciarGPS():pararGPS());
ui.btnCentralizarGps.addEventListener('click',()=>{acompanharGPS=true;if(ultimaPosicaoGPS)atualizarGPS(true);});
window.addEventListener('pagehide',()=>{if(gpsWatchId!==null)pararGPS();});

// ---------- CÂMERA / LEITURA DE FOTO ----------
ui.btnCamera.addEventListener('click',()=>ui.inputCamera.click());
ui.inputCamera.addEventListener('change',async e=>{
  const foto=e.target.files?.[0];if(!foto)return;
  if(!foto.type.startsWith('image/')){aviso('Escolha uma foto válida.',true);return;}
  busy(ui.btnCamera,true,'Lendo...');aviso('Reconhecendo o endereço da foto...');
  try {
    if(!window.Tesseract)throw new Error('Leitura de foto indisponível. Confira a conexão.');
    const res=await window.Tesseract.recognize(foto,'por+eng');
    const texto=(res.data.text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).join(', ');
    if(!texto)throw new Error('A foto não contém texto legível.');
    ui.endereco.value=texto;
    ui.endereco.dispatchEvent(new Event('input'));
    aviso('Texto preenchido. Confira a rua e o número antes de adicionar.');
    ui.endereco.focus();
  } catch(e){aviso(e.message||'Não foi possível ler a foto.',true);}
  finally{busy(ui.btnCamera,false);ui.inputCamera.value='';}
});

// ---------- INÍCIO ----------
ui.inputOrigem.value=origem.personalizado?origem.endereco:'';
ui.labelOrigem.textContent=origem.personalizado?'Origem definida':'São José dos Campos';
if(origem.personalizado)ui.ajudaOrigem.textContent='Seu ponto de partida foi salvo neste navegador.';
renderizar();
