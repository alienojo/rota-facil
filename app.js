// Elementos da Tela
const formParada = document.getElementById('form-parada');
const inputEndereco = document.getElementById('input-endereco');
const sugestoesContainer = document.getElementById('sugestoes-container');
const listaEntregas = document.getElementById('lista-entregas');
const contadorParadas = document.getElementById('contador-paradas');
const btnLimpar = document.getElementById('btn-limpar');
const btnOtimizar = document.getElementById('btn-otimizar');
const btnComecarRota = document.getElementById('btn-comecar-rota');
const btnResetarRota = document.getElementById('btn-resetar-rota');
const btnCamera = document.getElementById('btn-camera');
const inputFileCamera = document.getElementById('input-file-camera');

// Elementos de Origem (Ponto de Partida)
const inputOrigem = document.getElementById('input-origem');
const btnGpsAtual = document.getElementById('btn-gps-atual');
const labelStatusOrigem = document.getElementById('label-status-origem');

// Painel Bola da Vez
const painelBolaDaVez = document.getElementById('painel-bola-da-vez');
const numeroBolaDaVez = document.getElementById('numero-bola-da-vez');
const enderecoBolaDaVez = document.getElementById('endereco-bola-da-vez');
const btnNavegarAtiva = document.getElementById('btn-navegar-ativa');
const btnConcluirAtiva = document.getElementById('btn-concluir-ativa');
const statusMapa = document.getElementById('status-mapa');

let coordenadaSelecionada = null;
let timeoutBusca = null;
let rotaIniciada = JSON.parse(localStorage.getItem('rotafacil_iniciada')) || false;
let paradas = JSON.parse(localStorage.getItem('rotafacil_paradas')) || [];

// Ponto de Origem salvo
let origemRota = JSON.parse(localStorage.getItem('rotafacil_origem')) || {
    endereco: "São José dos Campos, SP",
    lat: -23.1794,
    lon: -45.8869,
    personalizado: false
};

inputOrigem.value = origemRota.personalizado ? origemRota.endereco : '';
if (origemRota.personalizado) {
    labelStatusOrigem.textContent = "Origem Definida";
}

// 1. MAPA INICIAL
let map = L.map('map').setView([origemRota.lat, origemRota.lon], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
}).addTo(map);

let markersLayer = L.layerGroup().addTo(map);
let polylineLayer = L.layerGroup().addTo(map);

function salvarERenderizar() {
    localStorage.setItem('rotafacil_paradas', JSON.stringify(paradas));
    localStorage.setItem('rotafacil_iniciada', JSON.stringify(rotaIniciada));
    localStorage.setItem('rotafacil_origem', JSON.stringify(origemRota));
    renderizarParadas();
    atualizarMapaERotas();
    atualizarPainelBolaDaVez();
}

// 2. CONFIGURAR ORIGEM VIA GPS DO APARELHO
btnGpsAtual.addEventListener('click', () => {
    if (!navigator.geolocation) {
        alert("Seu navegador não suporta geolocalização.");
        return;
    }

    btnGpsAtual.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i>`;
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            // Busca o nome do local aproximado pelas coordenadas (Geocodificação Reversa)
            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
                const data = await res.json();
                const nomeLocal = data.display_name ? data.display_name.split(',')[0] + ' (Minha Localização)' : 'Localização Atual';

                origemRota = {
                    endereco: nomeLocal,
                    lat: lat,
                    lon: lon,
                    personalizado: true
                };

                inputOrigem.value = nomeLocal;
                labelStatusOrigem.textContent = "GPS Ativo";
                btnGpsAtual.innerHTML = `<i class="fa-solid fa-crosshairs text-sm"></i> GPS`;
                salvarERenderizar();
                alert("📍 Ponto de partida definido com sucesso para sua localização atual!");
            } catch (err) {
                origemRota = { endereco: "Localização GPS", lat: lat, lon: lon, personalizado: true };
                inputOrigem.value = "Minha Localização Atual";
                labelStatusOrigem.textContent = "GPS Ativo";
                btnGpsAtual.innerHTML = `<i class="fa-solid fa-crosshairs text-sm"></i> GPS`;
                salvarERenderizar();
            }
        },
        (error) => {
            btnGpsAtual.innerHTML = `<i class="fa-solid fa-crosshairs text-sm"></i> GPS`;
            alert("Não foi possível obter sua localização. Verifique as permissões do GPS.");
        },
        { enableHighAccuracy: true }
    );
});

// CONFIGURAR ORIGEM DIGITADA
inputOrigem.addEventListener('change', async () => {
    const texto = inputOrigem.value.trim();
    if (!texto) return;

    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(texto)}&limit=1&countrycodes=br`);
        const data = await res.json();
        if (data && data.length > 0) {
            origemRota = {
                endereco: texto,
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                personalizado: true
            };
            labelStatusOrigem.textContent = "Origem Definida";
            salvarERenderizar();
            alert("📍 Ponto de partida atualizado!");
        }
    } catch (err) {
        alert("Não encontramos esse ponto de partida.");
    }
});

// 3. AUTOCOMPLETAR DE ENDEREÇOS DE ENTREGA
inputEndereco.addEventListener('input', (e) => {
    const termo = e.target.value.trim();
    coordenadaSelecionada = null;

    clearTimeout(timeoutBusca);
    if (termo.length < 3) {
        sugestoesContainer.classList.add('hidden');
        return;
    }

    const termoBuscaRua = termo.split(',')[0].trim();

    timeoutBusca = setTimeout(() => {
        buscarSugestoesCompletas(termoBuscaRua, termo);
    }, 350);
});

async function buscarSugestoesCompletas(termoRua, textoDigitadoPeloUsuario) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(termoRua)}&addressdetails=1&limit=6&countrycodes=br`;
        const response = await fetch(url);
        const data = await response.json();

        if (data && data.length > 0) {
            sugestoesContainer.innerHTML = '';
            data.forEach(item => {
                const addr = item.address || {};
                
                const logradouro = addr.road || addr.pedestrian || addr.suburb || item.display_name.split(',')[0];
                const bairro = addr.suburb || addr.neighbourhood || addr.city_district || addr.quarter || '';
                const cidade = addr.city || addr.town || addr.municipality || 'São José dos Campos';
                const cep = addr.postcode ? `CEP: ${addr.postcode}` : '';

                const matchNumero = textoDigitadoPeloUsuario.match(/\b\d+\b/);
                const numeroDigitado = matchNumero ? `, Nº ${matchNumero[0]}` : '';

                const partes = [];
                if (logradouro) partes.push(`${logradouro}${numeroDigitado}`);
                if (bairro) partes.push(bairro);
                if (cidade) partes.push(cidade);
                if (cep) partes.push(cep);

                const enderecoCompletoFormatado = partes.join(' — ');

                const div = document.createElement('div');
                div.className = 'p-3 hover:bg-slate-700/80 cursor-pointer text-xs text-slate-200 transition border-b border-slate-700/40 last:border-b-0 flex items-center gap-2';
                div.innerHTML = `<i class="fa-solid fa-location-dot text-emerald-400 shrink-0"></i> <span>${enderecoCompletoFormatado}</span>`;
                
                div.addEventListener('click', () => {
                    inputEndereco.value = enderecoCompletoFormatado;
                    coordenadaSelecionada = {
                        lat: parseFloat(item.lat),
                        lon: parseFloat(item.lon)
                    };
                    sugestoesContainer.classList.add('hidden');
                });

                sugestoesContainer.appendChild(div);
            });
            sugestoesContainer.classList.remove('hidden');
        }
    } catch (err) {
        console.error("Erro no autocompletar:", err);
    }
}

document.addEventListener('click', (e) => {
    if (!formParada.contains(e.target)) sugestoesContainer.classList.add('hidden');
});

// GEOCODIFICAÇÃO
async function geocodificarComPrecisao(enderecoCompleto) {
    if (coordenadaSelecionada) return coordenadaSelecionada;

    try {
        let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(enderecoCompleto)}&limit=1&countrycodes=br`;
        let response = await fetch(url);
        let data = await response.json();

        if (data && data.length > 0) {
            return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
        }
    } catch (error) {}

    return { lat: origemRota.lat, lon: origemRota.lon };
}

// ADICIONAR PARADA
formParada.addEventListener('submit', async (e) => {
    e.preventDefault();
    const enderecoTexto = inputEndereco.value.trim();
    if (!enderecoTexto) return;

    btnComecarRota.disabled = true;
    const originalTexto = btnComecarRota.innerHTML;
    btnComecarRota.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Localizando...`;

    const coords = await geocodificarComPrecisao(enderecoTexto);

    const novaParada = {
        id: Date.now(),
        endereco: enderecoTexto,
        lat: coords.lat,
        lon: coords.lon,
        concluida: false
    };

    paradas.push(novaParada);
    inputEndereco.value = '';
    coordenadaSelecionada = null;
    sugestoesContainer.classList.add('hidden');
    
    btnComecarRota.disabled = false;
    btnComecarRota.innerHTML = originalTexto;
    salvarERenderizar();
});

// 4. OTIMIZAR ROTA CONSIDERANDO O PONTO DE PARTIDA (ORIGEM)
btnOtimizar.addEventListener('click', async () => {
    if (paradas.length === 0) {
        alert("Adicione pelo menos 1 parada para otimizar.");
        return;
    }

    btnOtimizar.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Otimizando a partir da origem...`;

    let naoVisitadas = [...paradas];
    let otimizadas = [];
    
    // A partir da origem definida, encontra a parada mais próxima para ser a primeira da rota
    let pontoAtual = { lat: origemRota.lat, lon: origemRota.lon };

    while (naoVisitadas.length > 0) {
        let maisProximoIndex = 0;
        let menorDistancia = Infinity;

        naoVisitadas.forEach((p, index) => {
            let dist = Math.hypot(p.lat - pontoAtual.lat, p.lon - pontoAtual.lon);
            if (dist < menorDistancia) {
                menorDistancia = dist;
                maisProximoIndex = index;
            }
        });

        let proximaParada = naoVisitadas.splice(maisProximoIndex, 1)[0];
        otimizadas.push(proximaParada);
        pontoAtual = { lat: proximaParada.lat, lon: proximaParada.lon };
    }

    paradas = otimizadas;
    btnOtimizar.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Otimizar Rota`;
    salvarERenderizar();
    alert("✨ Rota otimizada calculada a partir do seu ponto de partida!");
});

// 5. ATUALIZAR MAPA E TRAÇADO DE RUAS (ORIGEM + PARADAS)
async function atualizarMapaERotas() {
    markersLayer.clearLayers();
    polylineLayer.clearLayers();

    let groupBounds = [[origemRota.lat, origemRota.lon]];

    // Marcador especial de Origem (Ponto de Partida)
    const iconOrigem = L.divIcon({
        className: 'custom-marker-origem',
        html: `<div style="background-color: #3b82f6; color: #ffffff; font-weight: bold; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-size: 14px;"><i class="fa-solid fa-house"></i></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    const markerOrigem = L.marker([origemRota.lat, origemRota.lon], { icon: iconOrigem }).bindPopup(`<b>Ponto de Partida</b><br>${origemRota.endereco}`);
    markersLayer.addLayer(markerOrigem);

    if (paradas.length === 0) {
        map.setView([origemRota.lat, origemRota.lon], 14);
        return;
    }

    const proximaPendente = paradas.find(p => !p.concluida);

    paradas.forEach((p, index) => {
        const numero = index + 1;
        const eBolaDaVez = proximaPendente && p.id === proximaPendente.id && rotaIniciada;
        groupBounds.push([p.lat, p.lon]);

        const customIcon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background-color: ${p.concluida ? '#64748b' : (eBolaDaVez ? '#ef4444' : '#10b981')}; color: #ffffff; font-weight: bold; width: ${eBolaDaVez ? '34px' : '28px'}; height: ${eBolaDaVez ? '34px' : '28px'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-size: ${eBolaDaVez ? '14px' : '12px'};">${numero}</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17]
        });

        const marker = L.marker([p.lat, p.lon], { icon: customIcon }).bindPopup(`<b>Parada #${numero}</b><br>${p.endereco}`);
        markersLayer.addLayer(marker);
    });

    if (groupBounds.length > 0) {
        map.fitBounds(groupBounds, { padding: [40, 40] });
    }

    // Traçado das ruas unindo Origem -> Paradas
    if (paradas.length > 0) {
        const pontosRota = [
            [origemRota.lat, origemRota.lon],
            ...paradas.map(p => [p.lat, p.lon])
        ];
        const coordsString = pontosRota.map(c => `${c[1]},${c[0]}`).join(';');
        const urlOSRM = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;

        try {
            const response = await fetch(urlOSRM);
            const data = await response.json();

            if (data.routes && data.routes.length > 0) {
                const routeCoordinates = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);

                const polyline = L.polyline(routeCoordinates, {
                    color: '#10b981',
                    weight: 5,
                    opacity: 0.85
                });
                polylineLayer.addLayer(polyline);
            }
        } catch (err) {
            console.error("Erro ao desenhar traçado de ruas:", err);
        }
    }
}

// 6. CONTROLE DE ROTA & BOLA DA VEZ
btnComecarRota.addEventListener('click', () => {
    if (paradas.length === 0) {
        alert("Adicione endereços para iniciar a rota.");
        return;
    }
    rotaIniciada = true;
    salvarERenderizar();
    alert("🚀 Rota Iniciada! O primeiro endereço está em destaque no topo.");
});

btnResetarRota.addEventListener('click', () => {
    const confirmacao = confirm("⚠️ Tem certeza que deseja iniciar outra rota?\n\nIsso apagará TODOS os endereços e entregas concluídas da rota atual!");
    if (confirmacao) {
        paradas = [];
        rotaIniciada = false;
        salvarERenderizar();
        alert("🧹 Rota resetada com sucesso!");
    }
});

function atualizarPainelBolaDaVez() {
    const pendentes = paradas.filter(p => !p.concluida);

    if (pendentes.length > 0 && rotaIniciada) {
        const bolaDaVez = pendentes[0];
        const numeroReal = paradas.findIndex(p => p.id === bolaDaVez.id) + 1;

        painelBolaDaVez.classList.remove('hidden');
        statusMapa.classList.remove('hidden');

        numeroBolaDaVez.textContent = numeroReal;
        enderecoBolaDaVez.textContent = bolaDaVez.endereco;
        
        btnNavegarAtiva.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bolaDaVez.endereco)}`;
        
        btnConcluirAtiva.onclick = () => {
            alternarConcluida(bolaDaVez.id);
        };
    } else {
        painelBolaDaVez.classList.add('hidden');
        statusMapa.classList.add('hidden');
    }
}

// CÂMERA / OCR SIMULADO
btnCamera.addEventListener('click', () => inputFileCamera.click());
inputFileCamera.addEventListener('change', (e) => {
    if (e.target.files[0]) {
        setTimeout(() => {
            inputEndereco.value = "Rua Votuporanga, Nº 264 — Bosque dos Eucaliptos — São José dos Campos — CEP: 12233-310";
            coordenadaSelecionada = { lat: -23.2200, lon: -45.8900 };
            alert("📸 Endereço capturado!");
        }, 600);
    }
});

// AÇÕES INDIVIDUAIS
function alternarConcluida(id) {
    paradas = paradas.map(p => {
        if (p.id === id) p.concluida = !p.concluida;
        return p;
    });
    salvarERenderizar();
}

function excluirParada(id) {
    paradas = paradas.filter(p => p.id !== id);
    salvarERenderizar();
}

btnLimpar.addEventListener('click', () => {
    paradas = paradas.filter(p => !p.concluida);
    salvarERenderizar();
});

function renderizarParadas() {
    listaEntregas.innerHTML = '';
    
    if (paradas.length === 0) {
        listaEntregas.innerHTML = `
            <div class="text-center py-8 text-slate-500 bg-slate-800/40 rounded-2xl border border-dashed border-slate-700">
                <i class="fa-solid fa-map-location-dot text-3xl mb-2 opacity-40"></i>
                <p class="text-sm">Nenhuma parada na rota.</p>
            </div>
        `;
        contadorParadas.textContent = '0 paradas';
        return;
    }

    contadorParadas.textContent = `${paradas.length} parada${paradas.length > 1 ? 's' : ''}`;

    const proximaPendente = paradas.find(p => !p.concluida);

    paradas.forEach((p, index) => {
        const card = document.createElement('div');
        const numero = index + 1;
        const eBolaDaVez = proximaPendente && p.id === proximaPendente.id && rotaIniciada;

        card.className = `parada-card bg-slate-800 border ${eBolaDaVez ? 'border-emerald-500/80 bg-slate-800/90' : 'border-slate-700'} rounded-2xl p-4 flex flex-col gap-3 shadow-md ${p.concluida ? 'concluida' : ''}`;
        
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.endereco)}`;

        card.innerHTML = `
            <div class="flex justify-between items-start gap-2">
                <div class="flex items-center gap-3 flex-1">
                    <span class="w-7 h-7 rounded-full ${eBolaDaVez ? 'bg-emerald-500 text-slate-950 font-extrabold' : 'bg-slate-700 text-emerald-400 font-bold'} flex items-center justify-center text-xs shrink-0">
                        ${numero}
                    </span>
                    <div>
                        <h3 class="text-sm font-semibold text-slate-200 ${p.concluida ? 'line-through text-slate-400' : ''}">${p.endereco}</h3>
                    </div>
                </div>
                <button onclick="excluirParada(${p.id})" class="text-slate-500 hover:text-rose-400 text-sm p-1">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            
            <div class="flex gap-2 pt-2 border-t border-slate-700/60">
                <a href="${mapsUrl}" target="_blank" class="flex-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 text-xs py-2 rounded-xl text-center font-medium transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-location-arrow"></i> Navegar
                </a>
                <button onclick="alternarConcluida(${p.id})" class="flex-1 ${p.concluida ? 'bg-slate-700 text-slate-300' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'} text-xs py-2 rounded-xl font-medium transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid ${p.concluida ? 'fa-rotate-left' : 'fa-check'}"></i> ${p.concluida ? 'Desfazer' : 'Entregue'}
                </button>
            </div>
        `;
        listaEntregas.appendChild(card);
    });
}

renderizarParadas();
atualizarMapaERotas();
atualizarPainelBolaDaVez();