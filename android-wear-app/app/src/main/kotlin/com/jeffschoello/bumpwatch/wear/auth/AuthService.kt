package com.jeffschoello.bumpwatch.wear.auth

import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.tasks.await

/**
 * Gives the app a stable per-rider identity via Firebase anonymous auth --
 * functionally the same role as AuthService.swift, but much simpler here:
 * unlike watchOS, the real Firebase Auth SDK runs directly on Wear OS, so
 * there's no need to hand-roll the Identity Toolkit REST calls or manage
 * token persistence/refresh ourselves the way AuthService.swift has to.
 * FirebaseAuth already persists the signed-in user across launches, and
 * getIdToken(false) transparently refreshes an expiring token before
 * returning it.
 */
class AuthService {
    private val auth = FirebaseAuth.getInstance()

    /** Returns a currently-valid ID token, signing in anonymously first on
     * a fresh install. UploadService calls this right before each upload
     * attempt rather than caching a token itself -- same reasoning as
     * AuthService.swift's currentIdToken(): a ride can sit queued offline
     * for a while, so a token fetched at ride-start could be stale by the
     * time it's actually sent. */
    suspend fun currentIdToken(): String {
        val user = auth.currentUser ?: auth.signInAnonymously().await().user!!
        return user.getIdToken(false).await().token!!
    }
}
