package com.tccode.companionapp;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;

import androidx.appcompat.app.AppCompatDelegate;

/**
 * Application class that handles app-wide configuration including theme.
 */
public class CompanionApp extends Application {

    private static final String PREFS_NAME = "companion_app_prefs";
    private static final String KEY_THEME_MODE = "theme_mode";

    public static final String THEME_SYSTEM = "system";
    public static final String THEME_LIGHT = "light";
    public static final String THEME_DARK = "dark";

    @Override
    public void onCreate() {
        super.onCreate();
        applyThemeMode(this);
    }

    /**
     * Apply the saved theme mode from SharedPreferences.
     */
    public static void applyThemeMode(Context context) {
        String themeMode = getThemeMode(context);

        switch (themeMode) {
            case THEME_LIGHT:
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
                break;
            case THEME_DARK:
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);
                break;
            default: // THEME_SYSTEM
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
                break;
        }
    }

    /**
     * Get the current theme mode from SharedPreferences.
     * 
     * @return The theme mode: "system", "light", or "dark"
     */
    public static String getThemeMode(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getString(KEY_THEME_MODE, THEME_SYSTEM);
    }

    /**
     * Save the theme mode to SharedPreferences and apply it.
     * 
     * @param themeMode The theme mode: "system", "light", or "dark"
     */
    public static void setThemeMode(Context context, String themeMode) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_THEME_MODE, themeMode).apply();
        applyThemeMode(context);
    }

    /**
     * Check if a custom primary color is configured.
     * 
     * @return true if PRIMARY_COLOR is set in BuildConfig
     */
    public static boolean hasCustomPrimaryColor() {
        String color = BuildConfig.PRIMARY_COLOR;
        return color != null && !color.isEmpty() && color.startsWith("#");
    }

    /**
     * Get the custom primary color from BuildConfig.
     * 
     * @return The color as an integer, or 0 if not set
     */
    public static int getCustomPrimaryColor() {
        if (hasCustomPrimaryColor()) {
            try {
                return Color.parseColor(BuildConfig.PRIMARY_COLOR);
            } catch (IllegalArgumentException e) {
                return 0;
            }
        }
        return 0;
    }
}
