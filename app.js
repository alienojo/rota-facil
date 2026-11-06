// CONFIGURAÇÕES E CHAVE LOCATIONIQ
const LOCATIONIQ_KEY = 'pk.a0eef454d73fac35adb0789e9d5b86c0';

// ESTADO DA APLICAÇÃO
let map;
let markers = [];
let routePolyline = null;
let stops = JSON.parse(localStorage.getItem('routeStops')) || [];
let originPoint = JSON.parse(localStorage.getItem('originPoint')) || null;

let tempOriginData = null;
let tempStopData = null;

// INICIALIZAÇÃO
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadSavedOrigin();
  renderStopsList();
  setupAutocomplete('originInput', 'originSuggestions', onSelectOrigin);
  setupAutocomplete('stopInput', 'stopSuggestions', onSelectStop);
  setupEvents();
  updateNextStopPanel();
});

// INICIALIZAR O MAPA (LEAFLET)
function initMap() {
  map = L.map('map').setView([-23.1791, -45.8872], 12); // São José dos Campos
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
}

// BUSCA COM AUTOCOMPLETAR USANDO LOCATIONIQ
function setupAutocomplete(inputId, listId, onSelectCallback) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let debounceTimer;

  input.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const query = e.target.value.trim();

    if (query.length < 3) {
      list.classList.add('hidden');
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const url = `https://api.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_KEY}&q=${encodeURIComponent(query)}&countrycodes=br&accept-language=pt&limit=5`;
        const res = await fetch(url);
        const data = await res.json();

        list.innerHTML = '';

        if (!Array.isArray(data) || data.length === 0) {
          list.classList.add('hidden');
          return;
        }

        data.forEach(item => {
          const li = document.createElement('li');
          li.className = 'px-3 py-2.5 hover:bg-slate-800 cursor-pointer border-b border-slate-800/80 last:border-none text-xs text-slate-200';
          li.textContent = item.display_name;

          li.addEventListener('click', () => {
            input.value = item.display_name;
            list.classList.add('hidden');
            onSelectCallback({
              address: item.display_name,
              lat: parseFloat(item.lat),
              lon: parseFloat(item.lon)
            });
          });

          list.appendChild(li);
        });

        list.classList.remove('hidden');
      } catch (err) {
        console.error("Erro na busca LocationIQ:", err);
      }
    }, 300);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.classList.add('hidden');
    }
  });
}

// CALLBACKS AO SELECIONAR UM ENDEREÇO DAS SUGESTÕES
function onSelectOrigin(data) {
  tempOriginData = data;
}

function onSelectStop(data) {
  tempStopData = data;
}

// CARREGAR E EXIBIR PONTO DE PARTIDA SALVO
function loadSavedOrigin() {
  const currentOriginText = document.getElementById('currentOriginText');
  if (originPoint && originPoint.address) {
    currentOriginText.textContent = `Partida atual: ${originPoint.address}`;
  } else {
    currentOriginText.textContent = 'Partida atual: Não definida';
  }
}

// CONFIGURAÇÃO DOS BOTÕES E EVENTOS
function setupEvents() {
  // Salvar Ponto de Partida
  document.getElementById('btnSetOrigin').addEventListener('click', () => {
    const inputVal = document.getElementById('originInput').value.trim();
    if (!inputVal) {
      alert('Digite ou selecione um ponto de partida.');
      return;
    }

    if (tempOriginData) {
      originPoint = tempOriginData;
    } else {
      originPoint = { address: inputVal, lat: null, lon: null };
    }

    localStorage.setItem('originPoint', JSON.stringify(originPoint));
    loadSavedOrigin();
    document.getElementById('originInput').value = '';
    tempOriginData = null;
    alert('Ponto de partida salvo com sucesso!');
  });

  // Adicionar Entrega
  document.getElementById('btnAddStop').addEventListener('click', async () => {
    const input = document.getElementById('stopInput');
    const addressStr = input.value.trim();

    if (!addressStr) return;

    let stopData = tempStopData;

    // Se o usuário digitou e clicou direto em adicionar sem selecionar a lista
    if (!stopData || stopData.address !== addressStr) {
      try {
        const url = `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_KEY}&q=${encodeURIComponent(addressStr)}&format=json&countrycodes=br&limit=1`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.length > 0) {
          stopData = {
            address: data[0].display_name,
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon)
          };
        } else {
          stopData = { address: addressStr, lat: null, lon: null };
        }
      } catch {
        stopData = { address: addressStr, lat: null, lon: null };
      }
    }

    stops.push({
      id: Date.now(),
      address: stopData.address,
      lat: stopData.lat,
      lon: stopData.lon,
      completed: false
    });

    saveStops();
    renderStopsList();
    input.value = '';
    tempStopData = null;
    updateNextStopPanel();
  });

  // Otimizar Rota (OSRM)
  document.getElementById('btnOptimize').addEventListener('click', optimizeRoute);

  // Limpar Tudo
  document.getElementById('btnClearAll').addEventListener('click', () => {
    if (confirm('Deseja apagar todas as entregas e a rota?')) {
      stops = [];
      saveStops();
      renderStopsList();
      clearMap();
      updateNextStopPanel();
    }
  });

  // Concluir Parada Atual
  document.getElementById('btnCompleteStop').addEventListener('click', () => {
    const nextStop = stops.find(s => !s.completed);
    if (nextStop) {
      nextStop.completed = true;
      saveStops();
      renderStopsList();
      updateNextStopPanel();
    }
  });

  // Navegação Externa
  document.getElementById('btnOpenGmaps').addEventListener('click', () => {
    const nextStop = stops.find(s => !s.completed);
    if (nextStop) {
      const query = nextStop.lat && nextStop.lon ? `${nextStop.lat},${nextStop.lon}` : encodeURIComponent(nextStop.address);
      window.open(`https://www.google.com/maps/search/?api=1&query=${query}`, '_blank');
    }
  });

  document.getElementById('btnOpenWaze').addEventListener('click', () => {
    const nextStop = stops.find(s => !s.completed);
    if (nextStop) {
      const query = nextStop.lat && nextStop.lon ? `${nextStop.lat},${nextStop.lon}` : encodeURIComponent(nextStop.address);
      window.open(`https://waze.com/ul?q=${query}&navigate=yes`, '_blank');
    }
  });
}

// SALVAR NO LOCALSTORAGE
function saveStops() {
  localStorage.setItem('routeStops', JSON.stringify(stops));
}

// RENDERIZAR LISTA DE ENTREGAS NA TELA
function renderStopsList() {
  const list = document.getElementById('stopsList');
  const countEl = document.getElementById('stopCount');
  list.innerHTML = '';
  countEl.textContent = stops.length;

  if (stops.length === 0) {
    list.innerHTML = '<li class="text-xs text-slate-500 italic py-2 text-center">Nenhuma entrega adicionada.</li>';
    return;
  }

  stops.forEach((stop, index) => {
    const li = document.createElement('li');
    li.className = `p-3 rounded-lg border flex justify-between items-center ${
      stop.completed 
        ? 'bg-slate-900/50 border-slate-800 text-slate-500 line-through' 
        : 'bg-slate-900 border-slate-700/80 text-slate-200'
    }`;

    li.innerHTML = `
      <div class="flex items-center gap-2 overflow-hidden pr-2">
        <span class="font-mono text-xs font-bold text-slate-400">#${index + 1}</span>
        <span class="truncate text-xs">${stop.address}</span>
      </div>
      <button onclick="removeStop(${stop.id})" class="text-rose-400 hover:text-rose-300 text-xs px-2 py-1 font-bold">
        ✕
      </button>
    `;

    list.appendChild(li);
  });
}

// REMOVER ENTREGA INDIVIDUAL
window.removeStop = function(id) {
  stops = stops.filter(s => s.id !== id);
  saveStops();
  renderStopsList();
  updateNextStopPanel();
};

// ATUALIZAR BOLA DA VEZ
function updateNextStopPanel() {
  const panel = document.getElementById('nextStopPanel');
  const addressEl = document.getElementById('nextStopAddress');
  const indexEl = document.getElementById('nextStopIndex');

  const pendingStops = stops.filter(s => !s.completed);

  if (pendingStops.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  const nextStop = pendingStops[0];
  const realIndex = stops.findIndex(s => s.id === nextStop.id) + 1;

  addressEl.textContent = nextStop.address;
  indexEl.textContent = `#${realIndex}`;
  panel.classList.remove('hidden');
}

// OTIMIZAR ROTA (CALCULAR CAMINHO COM OSRM)
async function optimizeRoute() {
  const validStops = stops.filter(s => s.lat && s.lon);

  if (validStops.length === 0) {
    alert('Adicione pelo menos um endereço válido para otimizar.');
    return;
  }

  clearMap();

  let coords = [];
  if (originPoint && originPoint.lat && originPoint.lon) {
    coords.push(`${originPoint.lon},${originPoint.lat}`);
  }

  validStops.forEach(s => coords.push(`${s.lon},${s.lat}`));

  if (coords.length < 2) {
    alert('Defina um ponto de partida ou adicione ao menos duas entregas com coordenadas.');
    return;
  }

  try {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coords.join(';')}?overview=full&geometries=geojson`;
    const res = await fetch(osrmUrl);
    const data = await res.json();

    if (data.routes && data.routes.length > 0) {
      const routeGeometry = data.routes[0].geometry;

      routePolyline = L.geoJSON(routeGeometry, {
        style: { color: '#3b82f6', weight: 5, opacity: 0.8 }
      }).addTo(map);

      // Adicionar Marcadores
      if (originPoint && originPoint.lat) {
        const originMarker = L.marker([originPoint.lat, originPoint.lon])
          .bindPopup(`<b>Partida:</b> ${originPoint.address}`)
          .addTo(map);
        markers.push(originMarker);
      }

      validStops.forEach((s, idx) => {
        const marker = L.marker([s.lat, s.lon])
          .bindPopup(`<b>#${idx + 1}:</b> ${s.address}`)
          .addTo(map);
        markers.push(marker);
      });

      map.fitBounds(routePolyline.getBounds(), { padding: [30, 30] });
    }
  } catch (err) {
    console.error("Erro ao calcular rota OSRM:", err);
    alert("Erro ao traçar rota. Verifique a conexão.");
  }
}

// LIMPAR ELEMENTOS DO MAPA
function clearMap() {
  if (routePolyline) {
    map.removeLayer(routePolyline);
    routePolyline = null;
  }
  markers.forEach(m => map.removeLayer(m));
  markers = [];
}