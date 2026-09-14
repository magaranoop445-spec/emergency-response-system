import { supabase, dbService } from './supabase-client.js';

// Authentication state
let currentSession = null;
let authListeners = [];

// Initialize auth
export async function initAuth() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
        console.error('Auth init error:', error);
        return null;
    }
    
    currentSession = session;
    if (session) {
        const user = await dbService.getCurrentUser();
        notifyAuthListeners(user);
        return user;
    }
    return null;
}

// Sign up
export async function signUp(userData) {
    try {
        // Validate phone number (Nepali format)
        const phoneRegex = /^98[0-9]{8}$/;
        if (!phoneRegex.test(userData.phone)) {
            throw new Error('Invalid phone number. Must be 10 digits starting with 98');
        }
        
        // Validate email (Gmail or organizational)
        const emailRegex = /^[^\s@]+@(gmail\.com|morgan\.edu\.np)$/;
        if (!emailRegex.test(userData.email)) {
            throw new Error('Invalid email. Use @gmail.com or @morgan.edu.np');
        }
        
        const user = await dbService.registerUser(userData);
        
        // If provider, create provider record
        if (userData.role === 'provider') {
            const { data: provider, error: providerError } = await supabase
                .from('providers')
                .insert({
                    provider_id: user.user_id,
                    organization_name: userData.organization_name,
                    provider_type: userData.provider_type,
                    license_number: userData.license_number
                });
                
            if (providerError) throw providerError;
        }
        
        // If admin, create admin record
        if (userData.role === 'admin') {
            const { data: admin, error: adminError } = await supabase
                .from('admins')
                .insert({
                    admin_id: user.user_id,
                    admin_level: userData.admin_level || 'local'
                });
                
            if (adminError) throw adminError;
        }
        
        return { success: true, user };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Sign in
export async function signIn(email, password) {
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        
        if (error) throw error;
        
        currentSession = data.session;
        const user = await dbService.getCurrentUser();
        notifyAuthListeners(user);
        
        return { success: true, user };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Sign out
export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    
    currentSession = null;
    notifyAuthListeners(null);
    return { success: true };
}

// Get current user
export async function getCurrentUser() {
    if (currentSession) {
        return await dbService.getCurrentUser();
    }
    return null;
}

// Auth state listener
export function onAuthStateChange(callback) {
    authListeners.push(callback);
    return () => {
        authListeners = authListeners.filter(cb => cb !== callback);
    };
}

function notifyAuthListeners(user) {
    authListeners.forEach(callback => callback(user));
}

// Password reset
export async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password.html`
    });
    
    if (error) throw error;
    return { success: true };
}

// Update password
export async function updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({
        password: newPassword
    });
    
    if (error) throw error;
    return { success: true };
}