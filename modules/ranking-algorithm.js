export class RankingAlgorithm {
    constructor() {
        this.weights = {
            humanHarm: 0.55,
            timeDecay: 0.20,
            proximity: 0.20,
            adminBoost: 0.05
        };
        
        this.typeMultipliers = {
            'Medical': 1.2,
            'Fire': 1.5,
            'Police': 1.1,
            'Accident': 1.3,
            'NaturalDisaster': 1.6
        };
    }

    // Normalize type so "fire", "Fire", "FIRE" all map correctly
    getTypeKey(type) {
        if (!type) return null;
        const t = String(type).trim().toLowerCase();
        const map = {
            'medical': 'Medical',
            'fire': 'Fire',
            'police': 'Police',
            'accident': 'Accident',
            'naturaldisaster': 'NaturalDisaster',
            'natural disaster': 'NaturalDisaster'
        };
        return map[t] || null;
    }

    calculateHumanHarmScore(incident) {
        // Prefer stored value
        if (incident.human_harm_score != null && Number(incident.human_harm_score) > 0) {
            return Number(incident.human_harm_score);
        }
        // Fallback: compute from q values
        const q1 = Number(incident.q1_threat_to_life ?? incident.q1 ?? 0) || 0;
        const q2 = Number(incident.q2_people_affected ?? incident.q2 ?? 0) || 0;
        const q3 = Number(incident.q3_urgency ?? incident.q3 ?? 0) || 0;
        if (q1 === 0 && q2 === 0 && q3 === 0) return 0;
        return (q1 + q2 + q3) / 3;
    }

    calculateTimeDecayScore(timestamp) {
        if (!timestamp) return 100;
        const elapsedMinutes = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60);
        if (elapsedMinutes <= 30) return 100;
        const decayFactor = Math.pow(0.5, (elapsedMinutes - 30) / 30);
        return Math.max(0, 100 * decayFactor);
    }

    // 🔧 FIXED: no-coords default 80 (was 50); real coords range 75-95 (was 60-85)
    calculateProximityScore(incidentLat, incidentLng, incidentType = 'Medical') {
        if (!incidentLat || !incidentLng) return 80;

        const latFactor = (Math.sin(incidentLat * 10) + 1) / 2;
        const lngFactor = (Math.cos(incidentLng * 10) + 1) / 2;
        const locationQuality = (latFactor + lngFactor) / 2;

        let baseProximity = 75 + (locationQuality * 20);  // 75-95

        const typeKey = this.getTypeKey(incidentType) || incidentType;
        const typeProximity = {
            'Medical': 1.05,
            'Fire': 1.08,
            'Police': 1.03,
            'Accident': 1.05,
            'NaturalDisaster': 0.92
        };
        const typeMultiplier = typeProximity[typeKey] || 1.0;
        let proximityScore = baseProximity * typeMultiplier;

        const coordHash = Math.abs(Math.floor(incidentLat * 1000) + Math.floor(incidentLng * 1000));
        const variation = 0.96 + ((coordHash % 8) / 100);
        proximityScore = proximityScore * variation;

        return Math.round(Math.min(100, Math.max(60, proximityScore)));
    }

    calculateFinalPriority(incident, adminBoost = 0) {
        const humanHarm = this.calculateHumanHarmScore(incident);
        const timeDecay = this.calculateTimeDecayScore(incident.created_at);
        const proximity = this.calculateProximityScore(
            incident.latitude,
            incident.longitude,
            incident.emergency_type
        );

        let finalScore = (humanHarm * this.weights.humanHarm) +
                        (timeDecay * this.weights.timeDecay) +
                        (proximity * this.weights.proximity) +
                        (adminBoost * this.weights.adminBoost);

        const typeKey = this.getTypeKey(incident.emergency_type);
        const multiplier = this.typeMultipliers[typeKey] || 1.0;
        finalScore = Math.min(100, finalScore * multiplier);

        // Debug log — check the server terminal
        console.log('[Ranking]', {
            emergency_type: incident.emergency_type,
            typeKey,
            humanHarm, timeDecay, proximity, adminBoost,
            weighted: Math.round((finalScore / multiplier) * 10) / 10,
            multiplier,
            final: Math.round(finalScore * 10) / 10
        });

        return finalScore;
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
            total: total,
            priority: this.getPriorityLevel(total),
            breakdown: {
                humanHarm: this.calculateHumanHarmScore(incident),
                timeDecay: this.calculateTimeDecayScore(incident.created_at),
                proximity: this.calculateProximityScore(
                    incident.latitude,
                    incident.longitude,
                    incident.emergency_type
                ),
                adminBoost: incident.admin_boost || 0
            }
        };
    }

    rankIncidents(incidents) {
        return incidents
            .map(incident => ({
                incident,
                ranking: this.calculateScore(incident)
            }))
            .sort((a, b) => b.ranking.total - a.ranking.total);
    }

    updateWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
    }
}