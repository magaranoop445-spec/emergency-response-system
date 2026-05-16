import { InvertedIndex } from './modules/inverted-index.js';
import { RankingAlgorithm } from './modules/ranking-algorithm.js';
import { DBSCANClusterer } from './modules/dbscan-clustering.js';

// Initialize modules
const invertedIndex = new InvertedIndex();
const rankingAlgo = new RankingAlgorithm();
const clusterer = new DBSCANClusterer(0.02, 3);

// Global state
let incidents = [];
let map;
let markers = {};
let currentRole = 'requester';
let historicalData = [];

// Load incidents from localStorage
function loadIncidents() {
    const stored = localStorage.getItem('emergency_incidents');
    if (stored) {
        incidents = JSON.parse(stored);
    } else {
        // Demo incidents
        incidents = [
            {
                id: 'demo1',
                type: 'Fire',
                locationDesc: 'Bagmati Province, Kathmandu, Thamel, Ward 16',
                details: 'Building fire, multiple floors affected, smoke visible',
                timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
                resolved: false,
                lat: 27.7167,
                lng: 85.3167,
                severityScore: 85,
                priority: 78,
                priorityLevel: 'HIGH',
                requesterId: 'demo_user'
            },
            {
                id: 'demo2',
                type: 'Medical',
                locationDesc: 'Bagmati Province, Lalitpur, Pulchowk, Ward 5',
                details: 'Medical emergency near bus stop, elderly person collapsed',
                timestamp: new Date(Date.now() - 45 * 60000).toISOString(),
                resolved: false,
                lat: 27.6738,
                lng: 85.3178,
                severityScore: 70,
                priority: 62,
                priorityLevel: 'MEDIUM',
                requesterId: 'demo_user'
            },
            {
                id: 'demo3',
                type: 'Accident',
                locationDesc: 'Bagmati Province, Kathmandu, Kalanki, Ward 14',
                details: 'Major traffic accident involving multiple vehicles',
                timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
                resolved: false,
                lat: 27.6905,
                lng: 85.2855,
                severityScore: 90,
                priority: 85,
                priorityLevel: 'CRITICAL',
                requesterId: 'demo_user'
            }
        ];
        saveIncidents();
    }
    updateAll();
}

function saveIncidents() {
    localStorage.setItem('emergency_incidents', JSON.stringify(incidents));
    updateAll();
}

function updateAll() {
    updateIncidentList();
    updatePriorityQueue();
    updateMapMarkers();
    updateStats();
    rebuildIndex();
    runClustering();
    updateAssignedIncidents();
    updateUserIncidents();
    updateVideoReviewList();
    updateBoostSelect();
}

function updateStats() {
    const total = incidents.length;
    const active = incidents.filter(i => !i.resolved).length;
    document.getElementById('totalIncidents').textContent = total;
    document.getElementById('activeIncidents').textContent = active;
    
    const completed = incidents.filter(i => i.resolved && i.completedAt).length;
    const avgResponse = completed > 0 ? 
        Math.round(incidents.filter(i => i.responseTime).reduce((a,b) => a + b.responseTime, 0) / completed) : 0;
    document.getElementById('avgResponseTime').textContent = avgResponse;
}

function rebuildIndex() {
    const activeIncidents = incidents.filter(i => !i.resolved);
    invertedIndex.rebuildIndex(activeIncidents);
}

async function runClustering() {
    const activeIncidents = incidents.filter(i => !i.resolved && i.lat && i.lng);
    const clusterResult = clusterer.cluster(activeIncidents);
    
    document.getElementById('hotspotCount').textContent = clusterResult.totalClusters;
    displayClusters(clusterResult);
    return clusterResult;
}

function displayClusters(clusterResult) {
    const container = document.getElementById('clustersList');
    if (!clusterResult.clusters.length) {
        container.innerHTML = '<div class="empty-msg">No significant clusters detected</div>';
        return;
    }
    
    container.innerHTML = clusterResult.clusters.map(cluster => `
        <div class="cluster-card">
            <h4>🔥 Cluster ${cluster.clusterId + 1}</h4>
            <p>📊 Size: ${cluster.size} incidents</p>
            <p>⚠️ Severity: ${cluster.severity.toFixed(1)}/10</p>
            <p>📋 Types: ${cluster.types.join(', ')}</p>
            <p>📍 Center: ${cluster.center.lat.toFixed(4)}, ${cluster.center.lng.toFixed(4)}</p>
            <p>🎯 Priority: ${cluster.priority}</p>
        </div>
    `).join('');
}

function updateIncidentList() {
    const container = document.getElementById('priorityQueueList');
    const activeIncidents = incidents.filter(i => !i.resolved);
    const ranked = rankingAlgo.rankIncidents(activeIncidents, historicalData);
    
    if (!ranked.length) {
        container.innerHTML = '<div class="empty-msg">No pending incidents</div>';
        return;
    }
    
    container.innerHTML = ranked.map(({incident, ranking}) => `
        <div class="incident-card" style="border-left-color: ${getPriorityColor(ranking.priority)}">
            <div class="incident-header">
                <strong>🚨 ${incident.type}</strong>
                <span class="priority-badge priority-${ranking.priority}">${ranking.priority}</span>
            </div>
            <div>📍 ${incident.locationDesc}</div>
            <div>📝 ${incident.details?.substring(0, 100) || 'No details'}</div>
            <div>⏱️ ${new Date(incident.timestamp).toLocaleString()}</div>
            <div>📊 Score: ${ranking.total.toFixed(1)}/100</div>
            <button onclick="acceptIncident('${incident.id}')" class="accept-btn">✅ Accept Request</button>
        </div>
    `).join('');
}

function updatePriorityQueue() {
    updateIncidentList();
}

function updateAssignedIncidents() {
    const container = document.getElementById('assignedIncidentsList');
    const assigned = incidents.filter(i => i.assignedTo === 'provider1' && !i.resolved);
    
    if (!assigned.length) {
        container.innerHTML = '<div class="empty-msg">No assigned incidents</div>';
        return;
    }
    
    container.innerHTML = assigned.map(incident => `
        <div class="incident-card">
            <div class="incident-header">
                <strong>${incident.type}</strong>
                <span>Status: ${incident.status || 'Assigned'}</span>
            </div>
            <div>📍 ${incident.locationDesc}</div>
            <button onclick="updateIncidentStatus('${incident.id}', 'en_route')" class="btn-secondary">🚗 En Route</button>
            <button onclick="updateIncidentStatus('${incident.id}', 'on_scene')" class="btn-secondary">📍 On Scene</button>
            <button onclick="resolveIncident('${incident.id}')" class="resolve-btn">✅ Complete</button>
        </div>
    `).join('');
    
    const completed = incidents.filter(i => i.assignedTo === 'provider1' && i.resolved).length;
    document.getElementById('completedCount').textContent = completed;
}

function updateUserIncidents() {
    const container = document.getElementById('userIncidentsList');
    const userIncidents = incidents.filter(i => i.requesterId === 'current_user');
    
    if (!userIncidents.length) {
        container.innerHTML = '<div class="empty-msg">No reports yet</div>';
        return;
    }
    
    container.innerHTML = userIncidents.map(incident => `
        <div class="incident-card" style="border-left-color: ${getPriorityColor(incident.priorityLevel)}">
            <div><strong>${incident.type}</strong> - ${new Date(incident.timestamp).toLocaleDateString()}</div>
            <div>Status: ${incident.resolved ? '✅ Resolved' : '🟡 Active'}</div>
        </div>
    `).join('');
}

function updateVideoReviewList() {
    const container = document.getElementById('videoReviewList');
    const incidentsWithVideo = incidents.filter(i => i.videoUrl && !i.resolved);
    
    if (!incidentsWithVideo.length) {
        container.innerHTML = '<div class="empty-msg">No videos pending review</div>';
        return;
    }
    
    container.innerHTML = incidentsWithVideo.map(incident => `
        <div class="incident-card">
            <div class="incident-header">
                <strong>${incident.type}</strong>
                <span>Priority: ${incident.priorityLevel}</span>
            </div>
            <div>📍 ${incident.locationDesc}</div>
            <video width="100%" controls>
                <source src="${incident.videoUrl}" type="video/mp4">
            </video>
        </div>
    `).join('');
}

function updateBoostSelect() {
    const select = document.getElementById('boostIncidentSelect');
    const activeIncidents = incidents.filter(i => !i.resolved);
    
    select.innerHTML = '<option value="">Select incident to boost</option>' +
        activeIncidents.map(i => `<option value="${i.id}">${i.type} - ${i.locationDesc.substring(0, 30)}</option>`).join('');
}

function updateMapMarkers() {
    if (!map) return;
    
    Object.values(markers).forEach(marker => map.removeLayer(marker));
    markers = {};
    
    const activeIncidents = incidents.filter(i => !i.resolved && i.lat && i.lng);
    
    activeIncidents.forEach(incident => {
        const color = getPriorityColor(incident.priorityLevel);
        const marker = L.marker([incident.lat, incident.lng], {
            icon: L.divIcon({
                className: 'emergency-marker',
                html: `<div style="background: ${color}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px ${color};"></div>`,
                iconSize: [20, 20]
            })
        }).bindPopup(`
            <strong>${incident.type}</strong><br>
            ${incident.locationDesc}<br>
            Priority: ${incident.priorityLevel}<br>
            ${new Date(incident.timestamp).toLocaleTimeString()}
        `).addTo(map);
        
        markers[incident.id] = marker;
    });
}

function getPriorityColor(priority) {
    switch(priority) {
        case 'CRITICAL': return '#dc2626';
        case 'HIGH': return '#f97316';
        case 'MEDIUM': return '#eab308';
        default: return '#22c55e';
    }
}

function calculatePriority(incident) {
    // 55% Human Harm
    const q1 = parseInt(document.querySelector('input[name="q1"]:checked')?.value || 0);
    const q2 = parseInt(document.querySelector('input[name="q2"]:checked')?.value || 0);
    const q3 = parseInt(document.querySelector('input[name="q3"]:checked')?.value || 0);
    const humanHarm = (q1 + q2 + q3) / 3;
    
    // 20% Time Decay (exponential after 30 min)
    const minutesElapsed = (Date.now() - new Date(incident.timestamp).getTime()) / 60000;
    const timeDecay = Math.min(100, Math.max(0, 100 * Math.exp(-Math.max(0, minutesElapsed - 30) / 60)));
    
    // 20% Proximity (mock)
    const proximity = 70;
    
    // 5% Admin Boost
    const adminBoost = incident.adminBoost || 0;
    
    const finalScore = (humanHarm * 0.55) + (timeDecay * 0.20) + (proximity * 0.20) + (adminBoost * 0.05);
    
    let priorityLevel = 'ROUTINE';
    if (finalScore >= 80) priorityLevel = 'CRITICAL';
    else if (finalScore >= 60) priorityLevel = 'HIGH';
    else if (finalScore >= 40) priorityLevel = 'MEDIUM';
    else if (finalScore >= 20) priorityLevel = 'LOW';
    
    return { score: finalScore, level: priorityLevel };
}

// Event Handlers
document.getElementById('emergencyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    
    const locationDesc = `${document.getElementById('province').value}, ${document.getElementById('district').value}, ${document.getElementById('municipality').value}, Ward ${document.getElementById('ward').value}, ${document.getElementById('tole').value}`;
    
    const priority = calculatePriority({ timestamp: new Date().toISOString() });
    
    const incident = {
        id: Date.now().toString(),
        type: document.getElementById('incidentType').value,
        locationDesc: locationDesc,
        details: document.getElementById('details').value,
        timestamp: new Date().toISOString(),
        resolved: false,
        lat: 27.7 + (Math.random() - 0.5) * 0.1,
        lng: 85.3 + (Math.random() - 0.5) * 0.1,
        severityScore: priority.score,
        priority: priority.score,
        priorityLevel: priority.level,
        requesterId: 'current_user'
    };
    
    incidents.push(incident);
    saveIncidents();
    
    e.target.reset();
    alert('Emergency reported successfully! Response team will be dispatched.');
});

// Role switching
document.querySelectorAll('.role-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const role = tab.dataset.role;
        document.querySelectorAll('.dashboard-panel').forEach(panel => panel.classList.remove('active'));
        
        if (role === 'requester') document.getElementById('requesterDashboard').classList.add('active');
        else if (role === 'provider') document.getElementById('providerDashboard').classList.add('active');
        else if (role === 'admin') document.getElementById('adminDashboard').classList.add('active');
    });
});

// Global functions
window.acceptIncident = (id) => {
    const incident = incidents.find(i => i.id === id);
    if (incident) {
        incident.assignedTo = 'provider1';
        incident.status = 'assigned';
        saveIncidents();
        alert('Incident accepted!');
    }
};

window.updateIncidentStatus = (id, status) => {
    const incident = incidents.find(i => i.id === id);
    if (incident) {
        incident.status = status;
        saveIncidents();
    }
};

window.resolveIncident = (id) => {
    const incident = incidents.find(i => i.id === id);
    if (incident) {
        incident.resolved = true;
        incident.completedAt = new Date().toISOString();
        incident.responseTime = Math.round((new Date(incident.completedAt) - new Date(incident.timestamp)) / 60000);
        saveIncidents();
        alert('Incident marked as completed!');
    }
};

window.applyPriorityBoost = () => {
    const select = document.getElementById('boostIncidentSelect');
    const id = select.value;
    if (!id) return;
    
    const incident = incidents.find(i => i.id === id);
    if (incident) {
        incident.adminBoost = (incident.adminBoost || 0) + 5;
        const newPriority = calculatePriority(incident);
        incident.priority = newPriority.score;
        incident.priorityLevel = newPriority.level;
        saveIncidents();
        alert(`Priority boost applied! New priority: ${newPriority.level}`);
    }
};

window.centerUserLocation = () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            map.setView([pos.coords.latitude, pos.coords.longitude], 14);
        });
    }
};

window.showHotspots = () => {
    runClustering().then(result => {
        if (result.clusters.length > 0) {
            map.setView([result.clusters[0].center.lat, result.clusters[0].center.lng], 12);
        }
    });
};

window.refreshClusters = () => runClustering();
window.suggestResources = () => {
    const activeIncidents = incidents.filter(i => !i.resolved && i.lat && i.lng);
    const result = clusterer.cluster(activeIncidents);
    const suggestions = clusterer.suggestResponseAllocation(result);
    alert(`Suggested resource allocation:\n${suggestions.map(s => `Cluster ${s.clusterId + 1}: ${s.suggestedUnits} units (${s.priority})`).join('\n')}`);
};

// Initialize map
function initMap() {
    map = L.map('map').setView([27.7172, 85.3240], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    
    map.on('click', (e) => {
        window.selectedCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
        document.getElementById('tole').value = `Clicked location: ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
    });
}

// Start app
window.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadIncidents();
});