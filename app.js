// Import modules
import { InvertedIndex } from './modules/inverted-index.js';
import { RankingAlgorithm } from './modules/ranking-algorithm.js';
import { DBSCANClusterer } from './modules/dbscan-clustering.js';
import { PriorityQueue } from './modules/priority-queue.js';

// Initialize modules
const invertedIndex = new InvertedIndex();
const rankingAlgo = new RankingAlgorithm();
const clusterer = new DBSCANClusterer(0.02, 3);
const priorityQueue = new PriorityQueue();

// Global state
let incidents = [];
let users = [];
let providers = [];
let feedbacks = [];
let auditLogs = [];
let currentUser = { id: 'current_user', name: 'Test User', role: 'requester' };
let currentRole = 'requester';
let maps = { requester: null, provider: null };
let markers = {};

// ==================== CLASS DEFINITIONS (from UML) ====================

class User {
    constructor(id, email, phone, fullName, role, province, district, municipality, ward, tole) {
        this.user_id = id;
        this.email = email;
        this.phone = phone;
        this.full_name = fullName;
        this.role = role; // requester, provider, admin
        this.is_verified = role === 'requester';
        this.province = province;
        this.district = district;
        this.municipality = municipality;
        this.ward = ward;
        this.tole = tole;
        this.created_at = new Date().toISOString();
        this.last_login = new Date().toISOString();
    }

    register() {
        users.push(this);
        this.logAction('register', 'User', this.user_id);
        return true;
    }

    login() {
        this.last_login = new Date().toISOString();
        this.logAction('login', 'User', this.user_id);
        return true;
    }

    updateProfile(data) {
        Object.assign(this, data);
        this.logAction('update_profile', 'User', this.user_id);
        return true;
    }

    logAction(action, entityType, entityId) {
        auditLogs.push({
            log_id: auditLogs.length + 1,
            user_id: this.user_id,
            action: action,
            entity_type: entityType,
            entity_id: entityId,
            created_at: new Date().toISOString()
        });
        saveToLocalStorage();
    }
}

class Provider extends User {
    constructor(id, email, phone, fullName, organizationName, providerType, licenseNumber) {
        super(id, email, phone, fullName, 'provider', '', '', '', 0, '');
        this.organization_name = organizationName;
        this.provider_type = providerType;
        this.license_number = licenseNumber;
        this.verified_by_admin = false;
        this.service_area_wards = [];
        this.is_available = true;
        this.total_services = 0;
        this.rating = 0;
    }

    acceptRequest(requestId) {
        const incident = incidents.find(i => i.request_id === requestId);
        if (incident && incident.status === 'pending') {
            incident.assigned_provider_id = this.user_id;
            incident.status = 'assigned';
            incident.assigned_at = new Date().toISOString();
            this.total_services++;
            this.logAction('accept_request', 'EmergencyRequest', requestId);
            saveToLocalStorage();
            updateAllDisplays();
            return true;
        }
        return false;
    }

    updateStatus(requestId, newStatus) {
        const incident = incidents.find(i => i.request_id === requestId);
        if (incident && incident.assigned_provider_id === this.user_id) {
            incident.status = newStatus;
            if (newStatus === 'completed') {
                incident.completed_at = new Date().toISOString();
            }
            this.logAction('update_status', 'EmergencyRequest', requestId);
            saveToLocalStorage();
            updateAllDisplays();
            return true;
        }
        return false;
    }

    getAssignedRequests() {
        return incidents.filter(i => i.assigned_provider_id === this.user_id);
    }
}

class Admin extends User {
    constructor(id, email, phone, fullName, adminLevel) {
        super(id, email, phone, fullName, 'admin', '', '', '', 0, '');
        this.admin_level = adminLevel;
        this.can_verify_providers = true;
        this.can_boost_priority = true;
        this.can_view_all_videos = true;
    }

    verifyProvider(providerId) {
        const provider = providers.find(p => p.user_id === providerId);
        if (provider) {
            provider.verified_by_admin = true;
            this.logAction('verify_provider', 'Provider', providerId);
            saveToLocalStorage();
            updateAllDisplays();
            return true;
        }
        return false;
    }

    boostPriority(requestId, reason, boostPercentage = 5) {
        const incident = incidents.find(i => i.request_id === requestId);
        if (incident) {
            incident.admin_boost = (incident.admin_boost || 0) + boostPercentage;
            incident.final_priority = this.calculateFinalPriority(incident);
            
            // Add to audit log
            auditLogs.push({
                log_id: auditLogs.length + 1,
                user_id: this.user_id,
                action: 'boost_priority',
                entity_type: 'EmergencyRequest',
                entity_id: requestId,
                old_values: { priority: incident.final_priority - boostPercentage },
                new_values: { priority: incident.final_priority },
                created_at: new Date().toISOString()
            });
            
            saveToLocalStorage();
            updateAllDisplays();
            return true;
        }
        return false;
    }

    calculateFinalPriority(incident) {
        return (incident.human_harm_score * 0.55) + 
               (incident.time_decay_score * 0.20) + 
               (incident.proximity_bonus * 0.20) + 
               ((incident.admin_boost || 0) * 0.05);
    }

    viewAnalytics() {
        const totalIncidents = incidents.length;
        const activeIncidents = incidents.filter(i => !['completed', 'cancelled'].includes(i.status)).length;
        const completedIncidents = incidents.filter(i => i.status === 'completed').length;
        const avgResponseTime = completedIncidents > 0 ? 
            incidents.filter(i => i.completed_at).reduce((sum, i) => {
                const responseTime = (new Date(i.completed_at) - new Date(i.created_at)) / 60000;
                return sum + responseTime;
            }, 0) / completedIncidents : 0;
        
        return { totalIncidents, activeIncidents, completedIncidents, avgResponseTime };
    }

    getHotspots() {
        const activeIncidents = incidents.filter(i => !['completed', 'cancelled'].includes(i.status));
        return clusterer.cluster(activeIncidents);
    }
}

class EmergencyRequest {
    constructor(requestorId, type, q1, q2, q3, description, province, district, municipality, ward, tole, lat, lng, injuredCount, fatalCount) {
        this.request_id = Date.now().toString();
        this.requestor_id = requestorId;
        this.assigned_provider_id = null;
        this.emergency_type = type;
        this.q1_threat_to_life = q1;
        this.q2_people_affected = q2;
        this.q3_urgency = q3;
        this.human_harm_score = (q1 + q2 + q3) / 3;
        this.description = description;
        this.province = province;
        this.district = district;
        this.municipality = municipality;
        this.ward = ward;
        this.tole = tole;
        this.latitude = lat;
        this.longitude = lng;
        this.video_url = null;
        this.injured_count = injuredCount || 0;
        this.fatal_count = fatalCount || 0;
        this.time_decay_score = 100;
        this.proximity_bonus = 70;
        this.admin_boost = 0;
        this.final_priority = this.human_harm_score;
        this.status = 'pending';
        this.created_at = new Date().toISOString();
        this.assigned_at = null;
        this.completed_at = null;
        this.resolution_notes = null;
        this.requestor_rating = null;
    }

    calculatePriority() {
        const timeElapsed = (Date.now() - new Date(this.created_at).getTime()) / 60000;
        this.time_decay_score = timeElapsed <= 30 ? 100 : Math.max(0, 100 * Math.exp(-(timeElapsed - 30) / 60));
        
        this.final_priority = (this.human_harm_score * 0.55) + 
                              (this.time_decay_score * 0.20) + 
                              (this.proximity_bonus * 0.20) + 
                              (this.admin_boost * 0.05);
        
        return this.final_priority;
    }

    getPriorityLevel() {
        if (this.final_priority >= 80) return 'CRITICAL';
        if (this.final_priority >= 60) return 'HIGH';
        if (this.final_priority >= 40) return 'MEDIUM';
        if (this.final_priority >= 20) return 'LOW';
        return 'ROUTINE';
    }

    updateStatus(newStatus) {
        this.status = newStatus;
        if (newStatus === 'completed') {
            this.completed_at = new Date().toISOString();
        }
        saveToLocalStorage();
        updateAllDisplays();
    }

    assignProvider(providerId) {
        this.assigned_provider_id = providerId;
        this.status = 'assigned';
        this.assigned_at = new Date().toISOString();
        saveToLocalStorage();
        updateAllDisplays();
    }

    addVideo(videoUrl) {
        this.video_url = videoUrl;
        saveToLocalStorage();
    }

    getTimeElapsed() {
        return (Date.now() - new Date(this.created_at).getTime()) / 60000;
    }
}

class Feedback {
    constructor(requestId, userId, rating, comment) {
        this.feedback_id = Date.now().toString();
        this.request_id = requestId;
        this.user_id = userId;
        this.rating = rating;
        this.comment_text = comment;
        this.created_at = new Date().toISOString();
    }

    submit() {
        feedbacks.push(this);
        
        // Update provider rating
        const incident = incidents.find(i => i.request_id === this.request_id);
        if (incident && incident.assigned_provider_id) {
            const provider = providers.find(p => p.user_id === incident.assigned_provider_id);
            if (provider) {
                const providerFeedbacks = feedbacks.filter(f => {
                    const inc = incidents.find(i => i.request_id === f.request_id);
                    return inc && inc.assigned_provider_id === provider.user_id;
                });
                provider.rating = providerFeedbacks.reduce((sum, f) => sum + f.rating, 0) / providerFeedbacks.length;
            }
        }
        
        incident.requestor_rating = rating;
        saveToLocalStorage();
        updateAllDisplays();
        return true;
    }
}

// ==================== INITIALIZATION ====================

function initializeData() {
    // Load from localStorage
    const storedIncidents = localStorage.getItem('esrs_incidents');
    const storedUsers = localStorage.getItem('esrs_users');
    const storedProviders = localStorage.getItem('esrs_providers');
    const storedFeedbacks = localStorage.getItem('esrs_feedbacks');
    const storedAuditLogs = localStorage.getItem('esrs_audit_logs');
    
    if (storedIncidents) incidents = JSON.parse(storedIncidents);
    if (storedUsers) users = JSON.parse(storedUsers);
    if (storedProviders) storedProviders ? providers = JSON.parse(storedProviders) : providers = [];
    if (storedFeedbacks) feedbacks = JSON.parse(storedFeedbacks);
    if (storedAuditLogs) auditLogs = JSON.parse(storedAuditLogs);
    
    // Create demo data if empty
    if (incidents.length === 0) {
        createDemoData();
    }
    
    if (providers.length === 0) {
        createDemoProviders();
    }
    
    updateAllDisplays();
}

function createDemoData() {
    const demoIncidents = [
        new EmergencyRequest('user1', 'Fire', 100, 60, 100, 'Building fire in Thamel', 'Bagmati Province', 'Kathmandu', 'Kathmandu Metro', 16, 'Thamel', 27.7167, 85.3167, 5, 0),
        new EmergencyRequest('user1', 'Medical', 100, 60, 100, 'Heart attack patient', 'Bagmati Province', 'Lalitpur', 'Lalitpur Metro', 5, 'Pulchowk', 27.6738, 85.3178, 1, 0),
        new EmergencyRequest('user1', 'Accident', 50, 60, 50, 'Bus accident', 'Bagmati Province', 'Kathmandu', 'Kathmandu Metro', 14, 'Kalanki', 27.6905, 85.2855, 8, 2)
    ];
    
    demoIncidents.forEach(incident => {
        incident.calculatePriority();
        incidents.push(incident);
    });
    
    saveToLocalStorage();
}

function createDemoProviders() {
    const demoProviders = [
        new Provider('prov1', 'fire@response.gov.np', '9841234567', 'Ram Bahadur', 'Kathmandu Fire Station', 'Fire', 'FIR-001'),
        new Provider('prov2', 'ambulance@health.gov.np', '9841234568', 'Sita Sharma', 'Central Ambulance Service', 'Medical', 'AMB-001'),
        new Provider('prov3', 'police@nepalpolice.gov.np', '9841234569', 'Hari Prasad', 'Metropolitan Police', 'Police', 'POL-001')
    ];
    
    providers.push(...demoProviders);
    saveToLocalStorage();
}

function saveToLocalStorage() {
    localStorage.setItem('esrs_incidents', JSON.stringify(incidents));
    localStorage.setItem('esrs_users', JSON.stringify(users));
    localStorage.setItem('esrs_providers', JSON.stringify(providers));
    localStorage.setItem('esrs_feedbacks', JSON.stringify(feedbacks));
    localStorage.setItem('esrs_audit_logs', JSON.stringify(auditLogs));
}

// ==================== UI UPDATE FUNCTIONS ====================

function updateAllDisplays() {
    updateMyIncidentsList();
    updatePriorityQueue();
    updateAssignedIncidents();
    updatePendingProviders();
    updateVideoReviewList();
    updateBoostSelect();
    updateAnalytics();
    updateClusters();
    updateMapMarkers();
    updateProviderStatistics();
    updateFeedbackSelect();
    rebuildSearchIndex();
}

function updateMyIncidentsList() {
    const container = document.getElementById('myIncidentsList');
    if (!container) return;
    
    const myIncidents = incidents.filter(i => i.requestor_id === 'current_user');
    
    if (myIncidents.length === 0) {
        container.innerHTML = '<div class="empty-state">No incidents reported yet</div>';
        return;
    }
    
    container.innerHTML = myIncidents.map(incident => `
        <div class="incident-card" style="border-left-color: ${getPriorityColor(incident.getPriorityLevel())}">
            <div class="incident-header">
                <strong>🚨 ${incident.emergency_type}</strong>
                <span class="priority-badge priority-${incident.getPriorityLevel()}">${incident.getPriorityLevel()}</span>
            </div>
            <div>📍 ${incident.district}, ${incident.municipality}, Ward ${incident.ward}</div>
            <div>📝 ${incident.description.substring(0, 80)}${incident.description.length > 80 ? '...' : ''}</div>
            <div>⏱️ ${new Date(incident.created_at).toLocaleString()}</div>
            <div>📊 Status: <span class="status-badge status-${incident.status}">${incident.status.toUpperCase()}</span></div>
            ${incident.status === 'completed' && !incident.requestor_rating ? 
                `<button onclick="rateIncident('${incident.request_id}')" class="btn-secondary" style="margin-top:8px">⭐ Rate this service</button>` : 
                incident.requestor_rating ? `<div>⭐ Your rating: ${incident.requestor_rating}/5</div>` : ''
            }
        </div>
    `).join('');
}

function updatePriorityQueue() {
    const container = document.getElementById('priorityQueueList');
    if (!container) return;
    
    const pendingIncidents = incidents.filter(i => i.status === 'pending');
    const rankedIncidents = rankingAlgo.rankIncidents(pendingIncidents);
    
    if (rankedIncidents.length === 0) {
        container.innerHTML = '<div class="empty-state">No pending incidents</div>';
        return;
    }
    
    container.innerHTML = rankedIncidents.map(({incident, ranking}) => `
        <div class="incident-card" style="border-left-color: ${getPriorityColor(ranking.priority)}">
            <div class="incident-header">
                <strong>🚨 ${incident.emergency_type}</strong>
                <span class="priority-badge priority-${ranking.priority}">${ranking.priority}</span>
            </div>
            <div>📍 ${incident.district}, ${incident.municipality}, Ward ${incident.ward}</div>
            <div>📝 ${incident.description.substring(0, 80)}${incident.description.length > 80 ? '...' : ''}</div>
            <div>⏱️ ${new Date(incident.created_at).toLocaleString()}</div>
            <div>📊 Score: ${ranking.total.toFixed(1)}/100</div>
            <button onclick="acceptIncident('${incident.request_id}')" class="accept-btn">✅ Accept Request</button>
        </div>
    `).join('');
}

function updateAssignedIncidents() {
    const container = document.getElementById('assignedIncidentsList');
    if (!container) return;
    
    const assignedIncidents = incidents.filter(i => i.assigned_provider_id === 'prov1' && i.status !== 'completed');
    
    if (assignedIncidents.length === 0) {
        container.innerHTML = '<div class="empty-state">No assigned incidents</div>';
        return;
    }
    
    container.innerHTML = assignedIncidents.map(incident => `
        <div class="incident-card">
            <div class="incident-header">
                <strong>${incident.emergency_type}</strong>
                <span class="status-badge status-${incident.status}">${incident.status.toUpperCase()}</span>
            </div>
            <div>📍 ${incident.district}, ${incident.municipality}</div>
            <div>👤 Reported by: ${incident.requestor_id}</div>
            ${incident.video_url ? `<div>🎥 Video evidence available</div>` : ''}
            <div class="button-group" style="margin-top:8px">
                <button onclick="updateIncidentStatus('${incident.request_id}', 'en_route')" class="btn-secondary">🚗 En Route</button>
                <button onclick="updateIncidentStatus('${incident.request_id}', 'on_scene')" class="btn-secondary">📍 On Scene</button>
                <button onclick="updateIncidentStatus('${incident.request_id}', 'completed')" class="resolve-btn">✅ Complete</button>
            </div>
        </div>
    `).join('');
}

function updatePendingProviders() {
    const container = document.getElementById('pendingProvidersList');
    if (!container) return;
    
    const pendingProviders = providers.filter(p => !p.verified_by_admin);
    
    if (pendingProviders.length === 0) {
        container.innerHTML = '<div class="empty-state">No pending provider verifications</div>';
        return;
    }
    
    container.innerHTML = pendingProviders.map(provider => `
        <div class="provider-card">
            <div class="incident-header">
                <strong>${provider.organization_name}</strong>
                <span>${provider.provider_type}</span>
            </div>
            <div>👤 ${provider.full_name}</div>
            <div>📧 ${provider.email}</div>
            <div>📞 ${provider.phone}</div>
            <div>📜 License: ${provider.license_number}</div>
            <button onclick="verifyProvider('${provider.user_id}')" class="verify-btn">✓ Verify Provider</button>
        </div>
    `).join('');
}

function updateVideoReviewList() {
    const container = document.getElementById('videoReviewList');
    if (!container) return;
    
    const incidentsWithVideo = incidents.filter(i => i.video_url);
    
    if (incidentsWithVideo.length === 0) {
        container.innerHTML = '<div class="empty-state">No videos pending review</div>';
        return;
    }
    
    container.innerHTML = incidentsWithVideo.map(incident => `
        <div class="incident-card">
            <div class="incident-header">
                <strong>${incident.emergency_type}</strong>
                <span>${incident.district}, Ward ${incident.ward}</span>
            </div>
            <div>📝 ${incident.description.substring(0, 60)}</div>
            <div class="video-placeholder" style="background:#e2e8f0; padding:1rem; text-align:center; border-radius:8px; margin-top:8px">
                🎥 Video evidence recorded
                <br><small>File would be stored in Supabase storage</small>
            </div>
        </div>
    `).join('');
}

function updateBoostSelect() {
    const select = document.getElementById('boostIncidentSelect');
    if (!select) return;
    
    const activeIncidents = incidents.filter(i => i.status !== 'completed' && i.status !== 'cancelled');
    
    select.innerHTML = '<option value="">Select incident to boost</option>' +
        activeIncidents.map(i => `<option value="${i.request_id}">${i.emergency_type} - ${i.district} (Current: ${i.final_priority.toFixed(1)} score)</option>`).join('');
}

function updateAnalytics() {
    const totalIncidents = incidents.length;
    const activeIncidents = incidents.filter(i => !['completed', 'cancelled'].includes(i.status)).length;
    const completedIncidents = incidents.filter(i => i.status === 'completed').length;
    const avgResponseTime = completedIncidents > 0 ? 
        Math.round(incidents.filter(i => i.completed_at).reduce((sum, i) => {
            const responseTime = (new Date(i.completed_at) - new Date(i.created_at)) / 60000;
            return sum + responseTime;
        }, 0) / completedIncidents) : 0;
    
    const verifiedProviders = providers.filter(p => p.verified_by_admin).length;
    
    document.getElementById('totalIncidents') && (document.getElementById('totalIncidents').textContent = totalIncidents);
    document.getElementById('activeIncidents') && (document.getElementById('activeIncidents').textContent = activeIncidents);
    document.getElementById('completedIncidents') && (document.getElementById('completedIncidents').textContent = completedIncidents);
    document.getElementById('avgResponseTime') && (document.getElementById('avgResponseTime').textContent = avgResponseTime);
    document.getElementById('verifiedProviders') && (document.getElementById('verifiedProviders').textContent = verifiedProviders);
}

function updateClusters() {
    const container = document.getElementById('clustersList');
    if (!container) return;
    
    const activeIncidents = incidents.filter(i => i.status !== 'completed');
    const clusterResult = clusterer.cluster(activeIncidents);
    
    document.getElementById('hotspotCount') && (document.getElementById('hotspotCount').textContent = clusterResult.totalClusters);
    
    if (clusterResult.clusters.length === 0) {
        container.innerHTML = '<div class="empty-state">No significant clusters detected</div>';
        return;
    }
    
    container.innerHTML = clusterResult.clusters.map(cluster => `
        <div class="cluster-card">
            <div class="incident-header">
                <strong>🔥 Cluster ${cluster.clusterId + 1}</strong>
                <span class="priority-badge priority-${cluster.priority}">${cluster.priority}</span>
            </div>
            <p>📊 Size: ${cluster.size} incidents</p>
            <p>⚠️ Avg Severity: ${cluster.severity.toFixed(1)}/10</p>
            <p>📋 Types: ${cluster.types.join(', ')}</p>
            <p>📍 Center: ${cluster.center.lat.toFixed(4)}, ${cluster.center.lng.toFixed(4)}</p>
        </div>
    `).join('');
}

function updateProviderStatistics() {
    const provider = providers.find(p => p.user_id === 'prov1');
    if (provider) {
        document.getElementById('totalServices') && (document.getElementById('totalServices').textContent = provider.total_services);
        document.getElementById('providerRating') && (document.getElementById('providerRating').textContent = provider.rating.toFixed(1));
    }
}

function updateFeedbackSelect() {
    const select = document.getElementById('feedbackIncidentSelect');
    if (!select) return;
    
    const completedIncidents = incidents.filter(i => i.status === 'completed' && !i.requestor_rating);
    
    select.innerHTML = '<option value="">Select incident to rate</option>' +
        completedIncidents.map(i => `<option value="${i.request_id}">${i.emergency_type} - ${i.district} (${new Date(i.completed_at).toLocaleDateString()})</option>`).join('');
}

function updateMapMarkers() {
    // Simple map update function
    console.log('Map markers updated');
}

function rebuildSearchIndex() {
    const activeIncidents = incidents.filter(i => i.status !== 'completed');
    invertedIndex.rebuildIndex(activeIncidents);
}

// ==================== EVENT HANDLERS ====================

function calculatePriorityFromForm() {
    const q1 = parseInt(document.querySelector('input[name="q1"]:checked')?.value || 0);
    const q2 = parseInt(document.querySelector('input[name="q2"]:checked')?.value || 0);
    const q3 = parseInt(document.querySelector('input[name="q3"]:checked')?.value || 0);
    return (q1 + q2 + q3) / 3;
}

document.getElementById('emergencyForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const humanHarmScore = calculatePriorityFromForm();
    
    const incident = new EmergencyRequest(
        'current_user',
        document.getElementById('incidentType').value,
        parseInt(document.querySelector('input[name="q1"]:checked')?.value || 0),
        parseInt(document.querySelector('input[name="q2"]:checked')?.value || 0),
        parseInt(document.querySelector('input[name="q3"]:checked')?.value || 0),
        document.getElementById('details').value,
        document.getElementById('province').value,
        document.getElementById('district').value,
        document.getElementById('municipality').value,
        parseInt(document.getElementById('ward').value),
        document.getElementById('tole').value,
        27.7 + (Math.random() - 0.5) * 0.1,
        85.3 + (Math.random() - 0.5) * 0.1,
        parseInt(document.getElementById('injuredCount')?.value || 0),
        parseInt(document.getElementById('fatalCount')?.value || 0)
    );
    
    incident.calculatePriority();
    incidents.push(incident);
    saveToLocalStorage();
    updateAllDisplays();
    
    e.target.reset();
    alert('✅ Emergency reported successfully! Priority: ' + incident.getPriorityLevel());
});

function acceptIncident(requestId) {
    const provider = providers.find(p => p.user_id === 'prov1');
    if (provider) {
        provider.acceptRequest(requestId);
        alert('Incident accepted!');
    }
}

function updateIncidentStatus(requestId, status) {
    const provider = providers.find(p => p.user_id === 'prov1');
    if (provider) {
        provider.updateStatus(requestId, status);
        alert(`Status updated to: ${status.toUpperCase()}`);
    }
}

function verifyProvider(providerId) {
    const admin = new Admin('admin1', 'admin@esrs.gov.np', '9841234570', 'Admin User', 'super');
    admin.verifyProvider(providerId);
    alert('Provider verified successfully!');
}

function applyPriorityBoost() {
    const select = document.getElementById('boostIncidentSelect');
    const requestId = select.value;
    const reason = document.getElementById('boostReason')?.value || 'Admin review';
    
    if (!requestId) {
        alert('Please select an incident');
        return;
    }
    
    const admin = new Admin('admin1', 'admin@esrs.gov.np', '9841234570', 'Admin User', 'super');
    admin.boostPriority(requestId, reason);
    alert('Priority boost applied!');
}

function searchIncidents() {
    const query = document.getElementById('searchInput')?.value;
    if (!query) return;
    
    const results = invertedIndex.search(query);
    const container = document.getElementById('searchResults');
    
    if (!results.length) {
        container.innerHTML = '<div class="empty-state">No matching incidents found</div>';
        return;
    }
    
    container.innerHTML = results.map(({incident, score}) => `
        <div class="incident-card">
            <div class="incident-header">
                <strong>${incident.emergency_type}</strong>
                <span>Score: ${score.toFixed(2)}</span>
            </div>
            <div>📍 ${incident.district}, ${incident.municipality}</div>
            <div>📝 ${incident.description.substring(0, 100)}</div>
            <div>⏱️ ${new Date(incident.created_at).toLocaleString()}</div>
        </div>
    `).join('');
}

function submitFeedback() {
    const select = document.getElementById('feedbackIncidentSelect');
    const requestId = select.value;
    const rating = parseInt(document.getElementById('selectedRating')?.value || 0);
    const comment = document.getElementById('feedbackComment')?.value || '';
    
    if (!requestId || rating === 0) {
        alert('Please select an incident and provide a rating');
        return;
    }
    
    const feedback = new Feedback(requestId, 'current_user', rating, comment);
    feedback.submit();
    
    alert('Thank you for your feedback!');
    document.getElementById('feedbackComment').value = '';
    document.getElementById('selectedRating').value = '0';
    updateAllDisplays();
}

function setRating(rating) {
    document.getElementById('selectedRating').value = rating;
    // Visual feedback
    const stars = document.querySelectorAll('.rating-stars span');
    stars.forEach((star, index) => {
        if (index < rating) {
            star.style.opacity = '1';
        } else {
            star.style.opacity = '0.3';
        }
    });
}

function rateIncident(requestId) {
    // Scroll to feedback section
    document.getElementById('feedbackIncidentSelect').value = requestId;
    document.querySelector('.rating-stars')?.scrollIntoView({ behavior: 'smooth' });
}

function suggestResourceAllocation() {
    const activeIncidents = incidents.filter(i => i.status !== 'completed');
    const result = clusterer.cluster(activeIncidents);
    const suggestions = clusterer.suggestResponseAllocation(result);
    
    if (suggestions.length === 0) {
        alert('No clusters detected for resource allocation');
        return;
    }
    
    alert('📊 Resource Allocation Suggestions:\n' + 
          suggestions.map(s => `Cluster ${s.clusterId + 1}: ${s.suggestedUnits} units (${s.priority} priority)`).join('\n'));
}

function viewHotspots() {
    const activeIncidents = incidents.filter(i => i.status !== 'completed');
    const result = clusterer.cluster(activeIncidents);
    
    if (result.clusters.length > 0) {
        alert(`🔥 ${result.totalClusters} hotspots detected!\nLargest cluster: ${result.clusters[0].size} incidents`);
    } else {
        alert('No significant hotspots detected');
    }
}

function toggleAvailability() {
    const provider = providers.find(p => p.user_id === 'prov1');
    if (provider) {
        provider.is_available = !provider.is_available;
        document.getElementById('availabilityStatus').textContent = provider.is_available ? 'Available' : 'Unavailable';
        alert(`Availability set to: ${provider.is_available ? 'Available' : 'Unavailable'}`);
        saveToLocalStorage();
    }
}

function centerUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            alert(`Your location: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
        });
    } else {
        alert('Geolocation not supported');
    }
}

// Role switching
document.getElementById('userRoleSelect')?.addEventListener('change', (e) => {
    currentRole = e.target.value;
    document.querySelectorAll('.dashboard-section').forEach(section => {
        section.classList.remove('active');
    });
    document.getElementById(`${currentRole}Dashboard`).classList.add('active');
    updateAllDisplays();
});

// Initialize maps
function initMaps() {
    // Simple map initialization would go here with Leaflet
    console.log('Maps initialized');
}

// Initialize the application
window.addEventListener('DOMContentLoaded', () => {
    initializeData();
    initMaps();
});

// Global exports for HTML onclick
window.acceptIncident = acceptIncident;
window.updateIncidentStatus = updateIncidentStatus;
window.verifyProvider = verifyProvider;
window.applyPriorityBoost = applyPriorityBoost;
window.searchIncidents = searchIncidents;
window.submitFeedback = submitFeedback;
window.setRating = setRating;
window.rateIncident = rateIncident;
window.suggestResourceAllocation = suggestResourceAllocation;
window.viewHotspots = viewHotspots;
window.toggleAvailability = toggleAvailability;
window.centerUserLocation = centerUserLocation;

function getPriorityColor(priority) {
    switch(priority) {
        case 'CRITICAL': return '#dc2626';
        case 'HIGH': return '#f97316';
        case 'MEDIUM': return '#eab308';
        case 'LOW': return '#22c55e';
        default: return '#64748b';
    }
}