import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ========== INLINED ALGORITHM MODULES (self-contained for Vercel) ==========

class InvertedIndex {
    constructor() {
        this.index = new Map();
        this.documents = new Map();
        this.stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','is','are','was','were','be','been','being','have','has','had','having']);
    }
    tokenize(text) {
        if (!text) return [];
        return text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, '').split(/\s+/).filter(w => w.length > 2 && !this.stopWords.has(w));
    }
    addDocument(incident) {
        const id = incident.request_id;
        this.documents.set(id, incident);
        const text = `${incident.emergency_type} ${incident.description} ${incident.district} ${incident.municipality} ${incident.tole}`;
        this.tokenize(text).forEach(token => {
            if (!this.index.has(token)) this.index.set(token, new Map());
            const m = this.index.get(token);
            m.set(id, (m.get(id) || 0) + 1);
        });
    }
    removeDocument(id) {
        this.documents.delete(id);
        for (let [term, docMap] of this.index) {
            docMap.delete(id);
            if (docMap.size === 0) this.index.delete(term);
        }
    }
    search(query) {
        const qTokens = this.tokenize(query);
        if (qTokens.length === 0) return [];
        const candidates = new Map();
        qTokens.forEach(t => {
            if (this.index.has(t)) {
                for (let [id, tf] of this.index.get(t)) {
                    if (!candidates.has(id)) candidates.set(id, new Map());
                    candidates.get(id).set(t, tf);
                }
            }
        });
        const results = [];
        const total = this.documents.size;
        for (let [id, tfMap] of candidates) {
            let score = 0;
            for (let [t, tf] of tfMap) {
                const df = this.index.get(t).size;
                const idf = Math.log((total + 1) / (df + 1)) + 1;
                score += tf * idf;
            }
            results.push({ incident: this.documents.get(id), score });
        }
        return results.sort((a, b) => b.score - a.score);
    }
    rebuildIndex(incidents) {
        this.index.clear();
        this.documents.clear();
        incidents.forEach(i => this.addDocument(i));
    }
    getAllDocuments() { return Array.from(this.documents.values()); }
}

class RankingAlgorithm {
    constructor() {
        this.weights = { humanHarm: 0.55, timeDecay: 0.20, proximity: 0.20, adminBoost: 0.05 };
        this.typeMultipliers = { 'Medical': 1.2, 'Fire': 1.5, 'Police': 1.1, 'Accident': 1.3, 'NaturalDisaster': 1.6 };
    }
    getTypeKey(type) {
        if (!type) return null;
        const t = String(type).trim().toLowerCase();
        const map = { 'medical': 'Medical', 'fire': 'Fire', 'police': 'Police', 'accident': 'Accident', 'naturaldisaster': 'NaturalDisaster', 'natural disaster': 'NaturalDisaster' };
        return map[t] || null;
    }
    calculateHumanHarmScore(incident) {
        if (incident.human_harm_score != null && Number(incident.human_harm_score) > 0) return Number(incident.human_harm_score);
        const q1 = Number(incident.q1_threat_to_life ?? incident.q1 ?? 0) || 0;
        const q2 = Number(incident.q2_people_affected ?? incident.q2 ?? 0) || 0;
        const q3 = Number(incident.q3_urgency ?? incident.q3 ?? 0) || 0;
        if (q1 === 0 && q2 === 0 && q3 === 0) return 0;
        return (q1 + q2 + q3) / 3;
    }
    calculateTimeDecayScore(timestamp) {
        if (!timestamp) return 100;
        const mins = (Date.now() - new Date(timestamp).getTime()) / 60000;
        if (mins <= 30) return 100;
        return Math.max(0, 100 * Math.pow(0.5, (mins - 30) / 30));
    }
    calculateProximityScore(lat, lng, type = 'Medical') {
        if (!lat || !lng) return 80;
        const lf = (Math.sin(lat * 10) + 1) / 2;
        const nf = (Math.cos(lng * 10) + 1) / 2;
        let base = 75 + (((lf + nf) / 2) * 20);
        const tk = this.getTypeKey(type) || type;
        const tmul = { 'Medical': 1.05, 'Fire': 1.08, 'Police': 1.03, 'Accident': 1.05, 'NaturalDisaster': 0.92 }[tk] || 1.0;
        let score = base * tmul;
        const hash = Math.abs(Math.floor(lat * 1000) + Math.floor(lng * 1000));
        score *= 0.96 + ((hash % 8) / 100);
        return Math.round(Math.min(100, Math.max(60, score)));
    }
    calculateFinalPriority(incident, adminBoost = 0) {
        const hh = this.calculateHumanHarmScore(incident);
        const td = this.calculateTimeDecayScore(incident.created_at);
        const px = this.calculateProximityScore(incident.latitude, incident.longitude, incident.emergency_type);
        let s = (hh * this.weights.humanHarm) + (td * this.weights.timeDecay) + (px * this.weights.proximity) + (adminBoost * this.weights.adminBoost);
        const tk = this.getTypeKey(incident.emergency_type);
        const mul = this.typeMultipliers[tk] || 1.0;
        s = Math.min(100, s * mul);
        console.log('[Ranking]', { type: incident.emergency_type, tk, hh, td, px, mul, final: Math.round(s * 10) / 10 });
        return s;
    }
    getPriorityLevel(score) {
        if (score >= 80) return 'CRITICAL';
        if (score >= 60) return 'HIGH';
        if (score >= 40) return 'MEDIUM';
        if (score >= 20) return 'LOW';
        return 'ROUTINE';
    }
    calculateScore(incident) {
        const total = this.calculateFinalPriority(incident, incident.admin_boost || 0);
        return {
            total,
            priority: this.getPriorityLevel(total),
            breakdown: {
                humanHarm: this.calculateHumanHarmScore(incident),
                timeDecay: this.calculateTimeDecayScore(incident.created_at),
                proximity: this.calculateProximityScore(incident.latitude, incident.longitude, incident.emergency_type),
                adminBoost: incident.admin_boost || 0
            }
        };
    }
    rankIncidents(incidents) {
        return incidents.map(i => ({ incident: i, ranking: this.calculateScore(i) }))
            .sort((a, b) => b.ranking.total - a.ranking.total);
    }
    updateWeights(w) { this.weights = { ...this.weights, ...w }; }
}

class DBSCANClusterer {
    constructor(epsilon = 0.02, minPoints = 3) {
        this.epsilon = epsilon;
        this.minPoints = minPoints;
    }
    haversineDistance(p1, p2) {
        const R = 6371;
        const lat1 = this.toRadians(p1.lat);
        const lat2 = this.toRadians(p2.lat);
        const dLat = this.toRadians(p2.lat - p1.lat);
        const dLng = this.toRadians(p2.lng - p1.lng);
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    toRadians(d) { return d * Math.PI / 180; }
    distance(p1, p2) { return this.haversineDistance(p1, p2); }
    regionQuery(points, idx, visited) {
        const neighbors = [];
        const p = points[idx];
        for (let i = 0; i < points.length; i++) {
            if (!visited.has(i) && this.distance(p, points[i]) <= this.epsilon * 111) neighbors.push(i);
        }
        return neighbors;
    }
    expandCluster(points, idx, neighbors, clusterId, labels, visited) {
        labels[idx] = clusterId;
        let i = 0;
        while (i < neighbors.length) {
            const cur = neighbors[i];
            if (!visited.has(cur)) {
                visited.add(cur);
                const curN = this.regionQuery(points, cur, visited);
                if (curN.length >= this.minPoints) {
                    for (const n of curN) if (!neighbors.includes(n)) neighbors.push(n);
                }
            }
            if (labels[cur] === -1) labels[cur] = clusterId;
            i++;
        }
    }
    cluster(incidents) {
        if (!incidents || incidents.length === 0) return { clusters: [], noise: [], totalClusters: 0 };
        const withCoords = incidents.filter(i => i.latitude && i.longitude && !isNaN(i.latitude) && !isNaN(i.longitude));
        if (withCoords.length < this.minPoints) return { clusters: [], noise: withCoords, totalClusters: 0 };
        const points = withCoords.map(i => ({ lat: i.latitude, lng: i.longitude, incident: i }));
        const n = points.length;
        const labels = new Array(n).fill(-1);
        const visited = new Set();
        let clusterId = 0;
        for (let i = 0; i < n; i++) {
            if (!visited.has(i)) {
                visited.add(i);
                const neighbors = this.regionQuery(points, i, visited);
                if (neighbors.length < this.minPoints) labels[i] = -1;
                else { this.expandCluster(points, i, neighbors, clusterId, labels, visited); clusterId++; }
            }
        }
        const clusters = new Map();
        for (let i = 0; i < n; i++) {
            if (labels[i] !== -1) {
                if (!clusters.has(labels[i])) clusters.set(labels[i], []);
                clusters.get(labels[i]).push(withCoords[i]);
            }
        }
        const sevMap = { 'Medical': 7, 'Fire': 9, 'Police': 6, 'Accident': 8, 'NaturalDisaster': 10 };
        const stats = [];
        for (let [id, incs] of clusters) {
            let sLat = 0, sLng = 0;
            incs.forEach(i => { sLat += i.latitude; sLng += i.longitude; });
            const center = { lat: sLat / incs.length, lng: sLng / incs.length };
            const severity = incs.reduce((s, i) => s + (sevMap[i.emergency_type] || 5), 0) / incs.length;
            const types = [...new Set(incs.map(i => i.emergency_type))];
            let priority = 'LOW';
            if (severity >= 8 && incs.length >= 5) priority = 'CRITICAL';
            else if (severity >= 7 && incs.length >= 3) priority = 'HIGH';
            else if (severity >= 5) priority = 'MEDIUM';
            stats.push({ clusterId: id, incidents: incs, size: incs.length, center, severity, types, priority });
        }
        return { clusters: stats, noise: withCoords.filter((_, i) => labels[i] === -1), totalClusters: clusters.size };
    }
    findHotspots(result, threshold = 3) {
        return result.clusters.filter(c => c.size >= threshold && c.severity >= 7);
    }
    suggestResponseAllocation(result) {
        const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        const sorted = [...result.clusters].sort((a, b) => order[b.priority] - order[a.priority]);
        return sorted.map(c => ({
            clusterId: c.clusterId, priority: c.priority,
            suggestedUnits: Math.max(1, Math.ceil(c.size / 2)),
            center: c.center,
            responseTime: c.priority === 'CRITICAL' ? 'IMMEDIATE' : c.priority === 'HIGH' ? 'WITHIN_5_MIN' : 'WITHIN_15_MIN',
            radius: c.size * 0.5
        }));
    }
}

class PriorityQueue {
    constructor() { this.heap = []; }
    getParentIndex(i) { return Math.floor((i - 1) / 2); }
    getLeftChildIndex(i) { return 2 * i + 1; }
    getRightChildIndex(i) { return 2 * i + 2; }
    swap(i, j) { [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]]; }
    enqueue(item) { this.heap.push(item); this.heapifyUp(this.heap.length - 1); }
    heapifyUp(i) {
        while (i > 0) {
            const p = this.getParentIndex(i);
            if (this.heap[p].priority >= this.heap[i].priority) break;
            this.swap(p, i);
            i = p;
        }
    }
    dequeue() {
        if (this.heap.length === 0) return null;
        if (this.heap.length === 1) return this.heap.pop();
        const max = this.heap[0];
        this.heap[0] = this.heap.pop();
        this.heapifyDown(0);
        return max;
    }
    heapifyDown(i) {
        let largest = i;
        const l = this.getLeftChildIndex(i);
        const r = this.getRightChildIndex(i);
        if (l < this.heap.length && this.heap[l].priority > this.heap[largest].priority) largest = l;
        if (r < this.heap.length && this.heap[r].priority > this.heap[largest].priority) largest = r;
        if (largest !== i) { this.swap(i, largest); this.heapifyDown(largest); }
    }
    peek() { return this.heap[0] || null; }
    size() { return this.heap.length; }
    isEmpty() { return this.heap.length === 0; }
    getAll() { return [...this.heap].sort((a, b) => b.priority - a.priority); }
    updatePriority(id, p) {
        const idx = this.heap.findIndex(i => i.id === id);
        if (idx !== -1) {
            const old = this.heap[idx].priority;
            this.heap[idx].priority = p;
            if (p > old) this.heapifyUp(idx); else this.heapifyDown(idx);
            return true;
        }
        return false;
    }
    remove(id) {
        const idx = this.heap.findIndex(i => i.id === id);
        if (idx !== -1) {
            this.swap(idx, this.heap.length - 1);
            this.heap.pop();
            if (idx < this.heap.length) this.heapifyDown(idx);
            return true;
        }
        return false;
    }
    clear() { this.heap = []; }
    print() { console.log(this.heap.map(i => ({ id: i.id, priority: i.priority }))); }
}

// ========== END INLINED MODULES ==========


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase configuration
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://xcylyhjslxvhwpgjnfje.supabase.co';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_4_yCpW7k13dtfpP-AIsFmQ_NCQXtQdE';
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize algorithm modules
const invertedIndex = new InvertedIndex();
const rankingAlgo = new RankingAlgorithm();
const clusterer = new DBSCANClusterer(0.02, 3);
const priorityQueue = new PriorityQueue();

// Cache for incidents
let cachedIncidents = [];
let lastCacheUpdate = null;
const CACHE_TTL = 60000;

// ==================== HELPER FUNCTIONS ====================

async function loadIncidentsFromDB() {
    const { data, error } = await supabase
        .from('emergency_requests')
        .select('*')
        .order('created_at', { ascending: false });
    
    if (error) {
        console.error('Error loading incidents:', error);
        return [];
    }
    return data;
}

async function updateCache() {
    console.log('Updating cache and algorithms...');
    const incidents = await loadIncidentsFromDB();
    cachedIncidents = incidents;
    lastCacheUpdate = Date.now();
    
    const activeIncidents = incidents.filter(i => i.status !== 'completed' && i.status !== 'cancelled');
    invertedIndex.rebuildIndex(activeIncidents);
    
    priorityQueue.clear();
    const rankedIncidents = rankingAlgo.rankIncidents(activeIncidents);
    rankedIncidents.forEach(({ incident, ranking }) => {
        priorityQueue.enqueue({
            id: incident.request_id,
            priority: ranking.total,
            incident: incident
        });
    });
    
    console.log(`✅ Cache updated: ${incidents.length} total, ${activeIncidents.length} active`);
    return incidents;
}

async function getIncidents(forceRefresh = false) {
    if (forceRefresh || !lastCacheUpdate || (Date.now() - lastCacheUpdate) > CACHE_TTL) {
        await updateCache();
    }
    return cachedIncidents;
}

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(compression());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== API ENDPOINTS ====================

// 1. INVERTED INDEX SEARCH API
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        
        await getIncidents(true);
        const results = invertedIndex.search(q);
        
        res.json({
            success: true,
            query: q,
            count: results.length,
            results: results.map(r => ({
                id: r.incident.request_id,
                type: r.incident.emergency_type,
                description: r.incident.description,
                location: `${r.incident.district}, ${r.incident.municipality}`,
                relevance_score: r.score,
                status: r.incident.status,
                priority: r.incident.priority_level,
                created_at: r.incident.created_at
            }))
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. WEIGHTED RANKING API
app.get('/api/ranked-incidents', async (req, res) => {
    try {
        await getIncidents(true);
        const activeIncidents = cachedIncidents.filter(i => i.status !== 'completed' && i.status !== 'cancelled');
        const ranked = rankingAlgo.rankIncidents(activeIncidents);
        
        res.json({
            success: true,
            count: ranked.length,
            incidents: ranked.map(({ incident, ranking }) => ({
                id: incident.request_id,
                type: incident.emergency_type,
                description: incident.description,
                location: `${incident.district}, ${incident.municipality}`,
                priority_score: ranking.total,
                priority_level: ranking.priority,
                breakdown: ranking.breakdown,
                status: incident.status,
                created_at: incident.created_at,
                requestor_id: incident.requestor_id,
                video_url: incident.video_url
            }))
        });
    } catch (error) {
        console.error('Ranking error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. PRIORITY QUEUE API
app.get('/api/priority-queue', async (req, res) => {
    try {
        await getIncidents(true);
        const nextIncident = priorityQueue.peek();
        
        res.json({
            success: true,
            queue_size: priorityQueue.size(),
            next_incident: nextIncident ? {
                id: nextIncident.id,
                priority: nextIncident.priority
            } : null,
            all_incidents: priorityQueue.getAll().map(item => ({
                id: item.id,
                priority: item.priority
            }))
        });
    } catch (error) {
        console.error('Priority queue error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. DBSCAN CLUSTERING API
app.get('/api/clusters', async (req, res) => {
    try {
        await getIncidents(true);
        const activeIncidents = cachedIncidents.filter(i => 
            i.status !== 'completed' && 
            i.status !== 'cancelled' && 
            i.latitude && i.longitude
        );
        
        const incidentsWithCoords = activeIncidents.map(i => ({
            request_id: i.request_id,
            emergency_type: i.emergency_type,
            latitude: i.latitude,
            longitude: i.longitude,
            priority_level: i.priority_level,
            description: i.description
        }));
        
        const clusterResult = clusterer.cluster(incidentsWithCoords);
        const hotspots = clusterer.findHotspots(clusterResult);
        const suggestions = clusterer.suggestResponseAllocation(clusterResult);
        
        res.json({
            success: true,
            total_clusters: clusterResult.totalClusters,
            clusters: clusterResult.clusters.map(c => ({
                id: c.clusterId,
                size: c.size,
                severity: c.severity,
                types: c.types,
                priority: c.priority,
                center: c.center
            })),
            hotspots: hotspots,
            resource_suggestions: suggestions,
            noise_count: clusterResult.noise.length
        });
    } catch (error) {
        console.error('Clustering error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. GET SINGLE INCIDENT WITH RANKING
app.get('/api/incident/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await getIncidents(true);
        const incident = cachedIncidents.find(i => i.request_id == id);
        
        if (!incident) {
            return res.status(404).json({ error: 'Incident not found' });
        }
        
        const ranking = rankingAlgo.calculateScore(incident);
        
        res.json({
            success: true,
            incident: incident,
            ranking: ranking
        });
    } catch (error) {
        console.error('Get incident error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. APPLY PRIORITY BOOST (Admin)
app.post('/api/incident/:id/boost', async (req, res) => {
    try {
        const { id } = req.params;
        const { boost_percentage, reason, admin_id } = req.body;
        
        const { data: incident, error: getError } = await supabase
            .from('emergency_requests')
            .select('admin_boost')
            .eq('request_id', id)
            .single();
        
        if (getError) throw getError;
        
        const newBoost = (incident.admin_boost || 0) + (boost_percentage || 5);
        
        const { data, error } = await supabase
            .from('emergency_requests')
            .update({ admin_boost: newBoost })
            .eq('request_id', id)
            .select();
        
        if (error) throw error;
        
        await supabase.from('admin_boosts').insert({
            request_id: id,
            admin_id: admin_id,
            boost_percentage: boost_percentage || 5,
            reason: reason || 'Admin review'
        });
        
        await updateCache();
        
        const updatedIncident = cachedIncidents.find(i => i.request_id == id);
        const newRanking = updatedIncident ? rankingAlgo.calculateScore(updatedIncident) : null;
        
        res.json({
            success: true,
            new_boost: newBoost,
            new_priority: newRanking,
            message: `Priority boosted by ${boost_percentage || 5}%`
        });
    } catch (error) {
        console.error('Boost error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. CREATE NEW INCIDENT
app.post('/api/incidents', async (req, res) => {
    try {
        const incidentData = req.body;
        
        console.log('Creating incident with data:', {
            requestor_id: incidentData.requestor_id,
            emergency_type: incidentData.emergency_type,
            has_video: !!incidentData.video_url
        });
        
        const q1 = Number(incidentData.q1) || 0;
        const q2 = Number(incidentData.q2) || 0;
        const q3 = Number(incidentData.q3) || 0;
        const humanHarm = (q1 + q2 + q3) / 3;
        
        const insertObj = {
            requestor_id: incidentData.requestor_id,
            emergency_type: incidentData.emergency_type,
            q1_threat_to_life: q1,
            q2_people_affected: q2,
            q3_urgency: q3,
            description: incidentData.description,
            province: incidentData.province || 'Bagmati Province',
            district: incidentData.district || 'Kathmandu',
            municipality: incidentData.municipality || 'Kathmandu Metro',
            ward: incidentData.ward || 1,
            tole: incidentData.tole || 'Unknown',
            latitude: incidentData.latitude,
            longitude: incidentData.longitude,
            injured_count: incidentData.injured_count || 0,
            fatal_count: incidentData.fatal_count || 0,
            human_harm_score: humanHarm,
            status: 'pending'
        };
        
        if (incidentData.video_url) {
            insertObj.video_url = incidentData.video_url;
        }
        if (incidentData.created_at) {
            insertObj.created_at = incidentData.created_at;
        }
        
        const { data, error } = await supabase
            .from('emergency_requests')
            .insert(insertObj)
            .select()
            .single();
        
        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(500).json({ error: error.message });
        }
        
        // Compute and write back the score so it's persisted in the DB
        const ranking = rankingAlgo.calculateScore(data);
        try {
            await supabase
                .from('emergency_requests')
                .update({
                    priority_level: ranking.priority,
                    final_priority: ranking.total
                })
                .eq('request_id', data.request_id);
        } catch (e) {
            console.warn('Score write-back failed (non-fatal):', e);
        }
        
        await updateCache();
        
        res.json({
            success: true,
            incident: data,
            ranking: ranking,
            queue_position: priorityQueue.size()
        });
    } catch (error) {
        console.error('Create incident error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 8. GET SYSTEM ANALYTICS
app.get('/api/analytics', async (req, res) => {
    try {
        await getIncidents(true);
        
        const total = cachedIncidents.length;
        const active = cachedIncidents.filter(i => i.status !== 'completed' && i.status !== 'cancelled').length;
        const completed = cachedIncidents.filter(i => i.status === 'completed').length;
        
        const avgPriority = active > 0 ? 
            cachedIncidents.filter(i => i.status !== 'completed').reduce((sum, i) => sum + (i.final_priority || 0), 0) / active : 0;
        
        const priorityDistribution = {
            CRITICAL: cachedIncidents.filter(i => i.priority_level === 'CRITICAL').length,
            HIGH: cachedIncidents.filter(i => i.priority_level === 'HIGH').length,
            MEDIUM: cachedIncidents.filter(i => i.priority_level === 'MEDIUM').length,
            LOW: cachedIncidents.filter(i => i.priority_level === 'LOW').length
        };
        
        const activeWithCoords = cachedIncidents.filter(i => i.latitude && i.longitude && i.status !== 'completed');
        const clusterResult = clusterer.cluster(activeWithCoords.map(i => ({
            latitude: i.latitude,
            longitude: i.longitude,
            emergency_type: i.emergency_type
        })));
        
        res.json({
            success: true,
            total_incidents: total,
            active_incidents: active,
            completed_incidents: completed,
            average_priority_score: avgPriority.toFixed(2),
            priority_distribution: priorityDistribution,
            hotspots_detected: clusterResult.totalClusters,
            queue_size: priorityQueue.size(),
            indexed_documents: invertedIndex.getAllDocuments().length,
            cache_age: lastCacheUpdate ? Math.round((Date.now() - lastCacheUpdate) / 1000) + 's' : 'not cached'
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 9. REFRESH CACHE
app.post('/api/refresh', async (req, res) => {
    try {
        await updateCache();
        res.json({ 
            success: true, 
            message: 'Cache refreshed',
            incidents_count: cachedIncidents.length,
            queue_size: priorityQueue.size()
        });
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 10. HEALTH CHECK
app.get('/api/health', async (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        algorithms: {
            inverted_index: true,
            weighted_ranking: true,
            dbscan_clustering: true,
            priority_queue: true
        },
        cache: {
            incidents_count: cachedIncidents.length,
            last_update: lastCacheUpdate,
            age: lastCacheUpdate ? Math.round((Date.now() - lastCacheUpdate) / 1000) + 's' : 'not initialized'
        }
    });
});

// ==================== SERVE HTML FILES ====================

app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

app.get('/requester-dashboard.html', (req, res) => {
    res.sendFile(join(__dirname, 'requester-dashboard.html'));
});

app.get('/provider-dashboard.html', (req, res) => {
    res.sendFile(join(__dirname, 'provider-dashboard.html'));
});

app.get('/admin-dashboard.html', (req, res) => {
    res.sendFile(join(__dirname, 'admin-dashboard.html'));
});

// ==================== START SERVER ====================

if (!process.env.VERCEL) {
    app.listen(PORT, async () => {
        console.log(`🚨 Server running on http://localhost:${PORT}`);
        try {
            await updateCache();
            console.log('✅ System ready!');
        } catch (err) {
            console.error('Startup cache error:', err);
        }
    });
}

// Prime the cache once when the module loads (also runs on Vercel).
updateCache().catch(err => console.error('Background cache init failed:', err));

// For Vercel serverless deployment
export default app;