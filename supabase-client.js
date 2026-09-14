import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing Supabase credentials. Please check your .env file');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
    },
    realtime: {
        params: {
            eventsPerSecond: 10
        }
    }
});

// Database service functions
export const dbService = {
    // User operations
    async registerUser(userData) {
        // First create auth user
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: userData.email,
            password: userData.password,
            options: {
                data: {
                    full_name: userData.full_name,
                    role: userData.role
                }
            }
        });
        
        if (authError) throw authError;
        
        // Then create user record
        // 🔧 FIX: removed `location: POINT(...)` — users table has no location column
        const { data, error } = await supabase
            .from('users')
            .insert({
                user_id: authData.user.id,
                email: userData.email,
                phone: userData.phone,
                full_name: userData.full_name,
                role: userData.role,
                province: userData.province,
                district: userData.district,
                municipality: userData.municipality,
                ward: userData.ward,
                tole: userData.tole
            })
            .select()
            .single();
            
        if (error) throw error;
        return data;
    },
    
    async loginUser(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        if (error) throw error;
        
        // Update last login
        await supabase
            .from('users')
            .update({ last_login: new Date().toISOString() })
            .eq('user_id', data.user.id);
            
        return data;
    },
    
    async getCurrentUser() {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error) throw error;
        
        if (user) {
            const { data: userData, error: userError } = await supabase
                .from('users')
                .select('*, providers(*)')
                .eq('user_id', user.id)
                .single();
            if (userError) throw userError;
            return userData;
        }
        return null;
    },
    
    // Emergency Request operations
    async createEmergencyRequest(requestData) {
        // 🔧 FIX: removed `location: POINT(...)` — emergency_requests has no location column
        const { data, error } = await supabase
            .from('emergency_requests')
            .insert({
                requestor_id: requestData.requestor_id,
                emergency_type: requestData.emergency_type,
                q1_threat_to_life: requestData.q1,
                q2_people_affected: requestData.q2,
                q3_urgency: requestData.q3,
                description: requestData.description,
                province: requestData.province,
                district: requestData.district,
                municipality: requestData.municipality,
                ward: requestData.ward,
                tole: requestData.tole,
                latitude: requestData.latitude,
                longitude: requestData.longitude,
                injured_count: requestData.injured_count || 0,
                fatal_count: requestData.fatal_count || 0
            })
            .select()
            .single();
            
        if (error) throw error;
        
        // Add to audit log
        await this.addAuditLog({
            user_id: requestData.requestor_id,
            action: 'create_emergency_request',
            entity_type: 'emergency_requests',
            entity_id: data.request_id
        });
        
        return data;
    },
    
    async getEmergencyRequests(filters = {}) {
        let query = supabase
            .from('emergency_requests')
            .select('*, requestor:requestor_id(full_name, phone), provider:assigned_provider_id(organization_name)')
            .order('final_priority', { ascending: false });
            
        if (filters.status) {
            query = query.eq('status', filters.status);
        }
        if (filters.provider_id) {
            query = query.eq('assigned_provider_id', filters.provider_id);
        }
        if (filters.requestor_id) {
            query = query.eq('requestor_id', filters.requestor_id);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data;
    },
    
    async updateEmergencyRequestStatus(requestId, status, providerId) {
        const updateData = { status };
        
        // Set timestamp based on status
        if (status === 'assigned') {
            updateData.assigned_at = new Date().toISOString();
            updateData.assigned_provider_id = providerId;
        } else if (status === 'en_route') {
            updateData.en_route_at = new Date().toISOString();
        } else if (status === 'on_scene') {
            updateData.on_scene_at = new Date().toISOString();
        } else if (status === 'completed') {
            updateData.completed_at = new Date().toISOString();
        } else if (status === 'cancelled') {
            updateData.cancelled_at = new Date().toISOString();
        }
        
        const { data, error } = await supabase
            .from('emergency_requests')
            .update(updateData)
            .eq('request_id', requestId)
            .select()
            .single();
            
        if (error) throw error;
        
        // Add to audit log
        await this.addAuditLog({
            user_id: providerId,
            action: 'update_status',
            entity_type: 'emergency_requests',
            entity_id: requestId,
            new_values: { status }
        });
        
        return data;
    },
    
    // Provider operations
    async getProviders(filters = {}) {
        let query = supabase
            .from('providers')
            .select('*, user:user_id(full_name, email, phone)');
            
        if (filters.verified_only) {
            query = query.eq('verified_by_admin', true);
        }
        if (filters.provider_type) {
            query = query.eq('provider_type', filters.provider_type);
        }
        if (filters.is_available !== undefined) {
            query = query.eq('is_available', filters.is_available);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data;
    },
    
    async verifyProvider(providerId, adminId) {
        const { data, error } = await supabase
            .from('providers')
            .update({
                verified_by_admin: true,
                verified_at: new Date().toISOString(),
                verified_by: adminId
            })
            .eq('provider_id', providerId)
            .select()
            .single();
            
        if (error) throw error;
        
        // Add to audit log
        await this.addAuditLog({
            user_id: adminId,
            action: 'verify_provider',
            entity_type: 'providers',
            entity_id: providerId
        });
        
        return data;
    },
    
    // Admin operations
    async applyPriorityBoost(requestId, adminId, reason, boostPercentage = 5) {
        // First get current request
        const { data: request, error: getError } = await supabase
            .from('emergency_requests')
            .select('admin_boost')
            .eq('request_id', requestId)
            .single();
            
        if (getError) throw getError;
        
        // Update the boost
        const newBoost = (request.admin_boost || 0) + boostPercentage;
        const { data, error } = await supabase
            .from('emergency_requests')
            .update({ admin_boost: newBoost })
            .eq('request_id', requestId)
            .select()
            .single();
            
        if (error) throw error;
        
        // Record the boost in admin_boosts table
        await supabase
            .from('admin_boosts')
            .insert({
                request_id: requestId,
                admin_id: adminId,
                boost_percentage: boostPercentage,
                reason: reason
            });
            
        // Add to audit log
        await this.addAuditLog({
            user_id: adminId,
            action: 'apply_priority_boost',
            entity_type: 'emergency_requests',
            entity_id: requestId,
            old_values: { admin_boost: request.admin_boost },
            new_values: { admin_boost: newBoost }
        });
        
        return data;
    },
    
    // Feedback operations
    async submitFeedback(feedbackData) {
        const { data, error } = await supabase
            .from('feedback')
            .insert({
                request_id: feedbackData.request_id,
                user_id: feedbackData.user_id,
                rating: feedbackData.rating,
                comment_text: feedbackData.comment
            })
            .select()
            .single();
            
        if (error) throw error;
        
        // Update the request with rating
        await supabase
            .from('emergency_requests')
            .update({ requestor_rating: feedbackData.rating })
            .eq('request_id', feedbackData.request_id);
            
        return data;
    },
    
    // Video upload
    async uploadVideo(file, incidentId, userId) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${incidentId}_${Date.now()}.${fileExt}`;
        const filePath = `incident-videos/${fileName}`;
        
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('emergency-videos')
            .upload(filePath, file);
            
        if (uploadError) throw uploadError;
        
        // Get public URL
        const { data: urlData } = supabase.storage
            .from('emergency-videos')
            .getPublicUrl(filePath);
            
        // Update the request with video URL
        const { data, error } = await supabase
            .from('emergency_requests')
            .update({ video_url: urlData.publicUrl })
            .eq('request_id', incidentId)
            .select()
            .single();
            
        if (error) throw error;
        
        // Add to audit log
        await this.addAuditLog({
            user_id: userId,
            action: 'upload_video',
            entity_type: 'emergency_requests',
            entity_id: incidentId
        });
        
        return data;
    },
    
    // Audit log
    async addAuditLog(logData) {
        const { error } = await supabase
            .from('audit_logs')
            .insert({
                user_id: logData.user_id,
                action: logData.action,
                entity_type: logData.entity_type,
                entity_id: logData.entity_id,
                old_values: logData.old_values,
                new_values: logData.new_values
            });
            
        if (error) console.error('Audit log error:', error);
    },
    
    async getAuditLogs(filters = {}) {
        let query = supabase
            .from('audit_logs')
            .select('*, user:user_id(full_name, email)')
            .order('created_at', { ascending: false })
            .limit(100);
            
        if (filters.user_id) {
            query = query.eq('user_id', filters.user_id);
        }
        if (filters.action) {
            query = query.eq('action', filters.action);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data;
    },
    
    // Analytics
    async getSystemAnalytics() {
        const { data: totalIncidents, error: totalError } = await supabase
            .from('emergency_requests')
            .select('count', { count: 'exact', head: true });
            
        const { data: activeIncidents, error: activeError } = await supabase
            .from('emergency_requests')
            .select('count', { count: 'exact', head: true })
            .not('status', 'in', '("completed","cancelled")');
            
        const { data: avgResponse, error: responseError } = await supabase
            .from('emergency_requests')
            .select('completed_at, created_at')
            .not('completed_at', 'is', null);
            
        let avgResponseTime = 0;
        if (avgResponse && avgResponse.length > 0) {
            const totalMinutes = avgResponse.reduce((sum, req) => {
                const diff = (new Date(req.completed_at) - new Date(req.created_at)) / 60000;
                return sum + diff;
            }, 0);
            avgResponseTime = totalMinutes / avgResponse.length;
        }
        
        const { data: hotspotStats, error: hotspotError } = await supabase
            .rpc('get_hotspot_statistics');
            
        return {
            total_incidents: totalIncidents || 0,
            active_incidents: activeIncidents || 0,
            avg_response_time_minutes: Math.round(avgResponseTime),
            hotspots: hotspotStats || []
        };
    }
};

// Real-time subscriptions
export const subscribeToIncidents = (callback, filters = {}) => {
    let query = supabase
        .channel('incidents-channel')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'emergency_requests'
            },
            (payload) => {
                callback(payload);
            }
        );
        
    return query.subscribe();
};

export const subscribeToProviderUpdates = (providerId, callback) => {
    return supabase
        .channel(`provider-${providerId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'emergency_requests',
                filter: `assigned_provider_id=eq.${providerId}`
            },
            (payload) => {
                callback(payload);
            }
        )
        .subscribe();
};