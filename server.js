import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import your existing algorithm modules
import { InvertedIndex } from './modules/inverted-index.js';
import { RankingAlgorithm } from './modules/ranking-algorithm.js';
import { DBSCANClusterer } from './modules/dbscan-clustering.js';
import { PriorityQueue } from './modules/priority-queue.js';

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
        
        await getIncidents(true); // 🔧 FIX: force refresh
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
        await getIncidents(true); // 🔧 FIX: force refresh — this is what makes delete/add show up instantly
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
        await getIncidents(true); // 🔧 FIX: force refresh
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
        await getIncidents(true); // 🔧 FIX: force refresh
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
        await getIncidents(true); // 🔧 FIX: force refresh
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

// 7. CREATE NEW INCIDENT - FIXED: Added video_url support
app.post('/api/incidents', async (req, res) => {
    try {
        const incidentData = req.body;
        
        console.log('Creating incident with data:', {
            requestor_id: incidentData.requestor_id,
            emergency_type: incidentData.emergency_type,
            has_video: !!incidentData.video_url
        });
        
        const humanHarm = (incidentData.q1 + incidentData.q2 + incidentData.q3) / 3;
        
        // Prepare insert object with all fields
        const insertObj = {
            requestor_id: incidentData.requestor_id,
            emergency_type: incidentData.emergency_type,
            q1_threat_to_life: incidentData.q1 || 0,
            q2_people_affected: incidentData.q2 || 0,
            q3_urgency: incidentData.q3 || 0,
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
        
        // Add video_url if provided
        if (incidentData.video_url) {
            insertObj.video_url = incidentData.video_url;
        }
        
        // Add created_at if provided
        if (incidentData.created_at) {
            insertObj.created_at = incidentData.created_at;
        }
        
        // 🔧 FIX: removed the `insertObj.location = POINT(...)` line.
        // Your emergency_requests table does NOT have a `location` column, which is why
        // every insert was failing with "column location does not exist".
        
        const { data, error } = await supabase
            .from('emergency_requests')
            .insert(insertObj)
            .select()
            .single();
        
        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(500).json({ error: error.message });
        }
        
        await updateCache();
        
        const ranking = rankingAlgo.calculateScore(data);
        
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
        await getIncidents(true); // 🔧 FIX: force refresh
        
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

app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🚨 EMERGENCY SERVICE REPORT SYSTEM 🚨                     ║
║     Server running on http://localhost:${PORT}                  ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    console.log('📡 API Endpoints:');
    console.log('   GET  /api/search?q=query     - Inverted Index Search');
    console.log('   GET  /api/ranked-incidents   - Weighted Ranking');
    console.log('   GET  /api/priority-queue     - Priority Queue');
    console.log('   GET  /api/clusters           - DBSCAN Clustering');
    console.log('   GET  /api/health             - Health Check');
    console.log('   POST /api/incidents          - Create Incident (with video support)');
    
    await updateCache();
    console.log('\n✅ System ready!');
});

// For Vercel serverless deployment
export default app;