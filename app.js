body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.panel {
    border: 1px solid rgb(51 65 85 / 0.9);
    border-radius: 1rem;
    background: rgb(30 41 59 / 0.78);
    box-shadow: 0 12px 30px rgb(0 0 0 / 0.14);
}

.field {
    border: 1px solid #475569;
    border-radius: .75rem;
    background: #0f172a;
    padding: .7rem .85rem;
    color: #f1f5f9;
    font-size: .875rem;
    outline: none;
    transition: border-color .18s, box-shadow .18s;
}

.field:focus {
    border-color: #34d399;
    box-shadow: 0 0 0 3px rgb(52 211 153 / .12);
}

.field::placeholder { color: #64748b; }

.primary-button, .secondary-button, .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: .5rem;
    border-radius: .75rem;
    font-size: .8rem;
    font-weight: 700;
    transition: background .18s, border-color .18s, transform .18s, opacity .18s;
}

.primary-button {
    min-height: 42px;
    padding: .65rem .9rem;
    color: #052e25;
    background: #34d399;
}
.primary-button:hover { background: #6ee7b7; }
.secondary-button {
    min-height: 42px;
    padding: .65rem .9rem;
    color: #cbd5e1;
    border: 1px solid #475569;
    background: #334155;
}
.secondary-button:hover { background: #475569; }
.icon-button {
    width: 36px;
    height: 36px;
    border: 1px solid #475569;
    background: #334155;
    color: #cbd5e1;
}
.icon-button:hover { background: #475569; }
button:disabled { cursor: not-allowed; opacity: .55; }

.status-pill {
    border-radius: 999px;
    background: rgb(100 116 139 / .18);
    color: #cbd5e1;
    padding: .3rem .6rem;
    font-size: .65rem;
    font-weight: 700;
    white-space: nowrap;
}

.suggestions {
    position: absolute;
    z-index: 1000;
    top: calc(100% + .35rem);
    left: 0;
    right: 0;
    max-height: 15rem;
    overflow-y: auto;
    border: 1px solid #475569;
    border-radius: .8rem;
    background: #1e293b;
    box-shadow: 0 18px 35px rgb(0 0 0 / .4);
}

.suggestion-item {
    display: block;
    width: 100%;
    padding: .75rem;
    text-align: left;
    color: #e2e8f0;
    font-size: .75rem;
    border-bottom: 1px solid rgb(71 85 105 / .55);
}
.suggestion-item:last-child { border-bottom: 0; }
.suggestion-item:hover, .suggestion-item:focus { background: #334155; outline: none; }

.parada-card {
    border: 1px solid #475569;
    border-radius: .9rem;
    background: #1e293b;
    padding: .9rem;
    transition: opacity .2s, border-color .2s, background .2s;
}
.parada-card.ativa { border-color: #34d399; }
.parada-card.concluida {
    opacity: .58;
    background: rgb(15 23 42 / .65);
}
.empty-state {
    border: 1px dashed #475569;
    border-radius: .85rem;
    padding: 2rem 1rem;
    color: #94a3b8;
    text-align: center;
    font-size: .85rem;
}

.leaflet-container { background: #0f172a; font: inherit; }
.leaflet-popup-content-wrapper, .leaflet-popup-tip {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #475569;
}
.leaflet-popup-content { margin: 12px 14px; line-height: 1.5; }
.leaflet-control-attribution { font-size: 9px !important; }

@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        scroll-behavior: auto !important;
        animation-duration: .01ms !important;
        transition-duration: .01ms !important;
    }
}
