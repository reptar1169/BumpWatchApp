package com.tccode.companionapp;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.card.MaterialCardView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

public class SettingsActivity extends AppCompatActivity {

    private TextView themeValueText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        setContentView(R.layout.activity_settings);

        setupWindowInsets();
        setupNavigation();
        applyCustomPrimaryColor();
        setupSettingItems();
        setupVersionInfo();
        checkWatchAndShowRate();
    }

    private void applyCustomPrimaryColor() {
        if (CompanionApp.hasCustomPrimaryColor()) {
            int primaryColor = CompanionApp.getCustomPrimaryColor();

            // Apply to bottom navigation selected state (Settings is selected here)
            View navSettings = findViewById(R.id.nav_settings);
            ImageView settingsIcon = navSettings.findViewById(R.id.nav_settings_icon);
            TextView settingsText = navSettings.findViewById(R.id.nav_settings_label);
            if (settingsIcon != null)
                settingsIcon.setImageTintList(ColorStateList.valueOf(primaryColor));
            if (settingsText != null)
                settingsText.setTextColor(primaryColor);
        }
    }

    private void setupWindowInsets() {
        View mainContent = findViewById(R.id.settings_main_content);
        ViewCompat.setOnApplyWindowInsetsListener(mainContent, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(insets.left, insets.top, insets.right, 0);
            return windowInsets;
        });

        // Apply same insets handling for bottom nav as MainActivity
        View bottomNavCard = findViewById(R.id.bottom_nav_card);
        ViewCompat.setOnApplyWindowInsetsListener(bottomNavCard, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
            androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams params = (androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) v
                    .getLayoutParams();
            params.bottomMargin = insets.bottom + 20;
            v.setLayoutParams(params);
            return windowInsets;
        });
    }

    private void setupNavigation() {
        // Home button - go back to MainActivity
        View navHome = findViewById(R.id.nav_home);
        navHome.setOnClickListener(v -> finish());

        // Settings button - already on settings, no action needed
        View navSettings = findViewById(R.id.nav_settings);
        navSettings.setOnClickListener(v -> {
            // Already on settings page
        });
    }

    private void setupSettingItems() {
        // Theme - always visible
        themeValueText = findViewById(R.id.theme_value);
        updateThemeValueDisplay();
        findViewById(R.id.setting_theme).setOnClickListener(v -> showThemeDialog());

        // Rate & Review - visibility handled by checkWatchAndShowRate()
        findViewById(R.id.setting_rate).setOnClickListener(v -> openPlayStoreForRating());

        // More Apps - hide if MORE_APPS_URL is empty
        View moreAppsItem = findViewById(R.id.setting_more_apps);
        String moreAppsUrl = getString(R.string.more_apps_url);
        if (moreAppsUrl.isEmpty() || moreAppsUrl.equals("https://")) {
            moreAppsItem.setVisibility(View.GONE);
        } else {
            moreAppsItem.setOnClickListener(v -> openMoreApps());
        }

        // Contact Support - hide if SUPPORT_EMAIL is empty
        View contactItem = findViewById(R.id.setting_contact);
        String supportEmail = getString(R.string.support_email);
        if (supportEmail.isEmpty()) {
            contactItem.setVisibility(View.GONE);
        } else {
            contactItem.setOnClickListener(v -> openEmailClient());
        }

        // Share App - always visible
        findViewById(R.id.setting_share).setOnClickListener(v -> shareApp());

        // Privacy Policy - hide if PRIVACY_POLICY_URL is empty
        View privacyItem = findViewById(R.id.setting_privacy);
        String policyUrl = getString(R.string.policy_url);
        if (policyUrl.isEmpty() || policyUrl.equals("https://")) {
            privacyItem.setVisibility(View.GONE);
        } else {
            privacyItem.setOnClickListener(v -> openPrivacyPolicy());
        }

        // Update section visibility after setting up items
        updateEngagementSectionVisibility();
    }

    private void updateEngagementSectionVisibility() {
        View engagementHeader = findViewById(R.id.engagement_header);
        View engagementCard = findViewById(R.id.engagement_card);

        View rateItem = findViewById(R.id.setting_rate);
        View moreAppsItem = findViewById(R.id.setting_more_apps);

        boolean hasVisibleItems = rateItem.getVisibility() == View.VISIBLE ||
                moreAppsItem.getVisibility() == View.VISIBLE;

        int visibility = hasVisibleItems ? View.VISIBLE : View.GONE;
        engagementHeader.setVisibility(visibility);
        engagementCard.setVisibility(visibility);
    }

    private void updateThemeValueDisplay() {
        String currentTheme = CompanionApp.getThemeMode(this);
        int themeTextRes;

        switch (currentTheme) {
            case CompanionApp.THEME_LIGHT:
                themeTextRes = R.string.setting_theme_light;
                break;
            case CompanionApp.THEME_DARK:
                themeTextRes = R.string.setting_theme_dark;
                break;
            default:
                themeTextRes = R.string.setting_theme_system;
                break;
        }

        themeValueText.setText(themeTextRes);
    }

    private void showThemeDialog() {
        String currentTheme = CompanionApp.getThemeMode(this);

        // Create custom dialog view for iOS-style appearance
        View dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_theme_picker, null);

        AlertDialog dialog = new MaterialAlertDialogBuilder(this, R.style.ThemePickerDialogStyle)
                .setView(dialogView)
                .create();

        // Setup theme options
        View optionSystem = dialogView.findViewById(R.id.option_system);
        View optionLight = dialogView.findViewById(R.id.option_light);
        View optionDark = dialogView.findViewById(R.id.option_dark);

        ImageView checkSystem = dialogView.findViewById(R.id.check_system);
        ImageView checkLight = dialogView.findViewById(R.id.check_light);
        ImageView checkDark = dialogView.findViewById(R.id.check_dark);

        // Apply custom primary color to checkmarks if set
        if (CompanionApp.hasCustomPrimaryColor()) {
            int primaryColor = CompanionApp.getCustomPrimaryColor();
            ColorStateList colorStateList = ColorStateList.valueOf(primaryColor);
            checkSystem.setImageTintList(colorStateList);
            checkLight.setImageTintList(colorStateList);
            checkDark.setImageTintList(colorStateList);
        }

        // Set initial selection
        checkSystem.setVisibility(currentTheme.equals(CompanionApp.THEME_SYSTEM) ? View.VISIBLE : View.INVISIBLE);
        checkLight.setVisibility(currentTheme.equals(CompanionApp.THEME_LIGHT) ? View.VISIBLE : View.INVISIBLE);
        checkDark.setVisibility(currentTheme.equals(CompanionApp.THEME_DARK) ? View.VISIBLE : View.INVISIBLE);

        optionSystem.setOnClickListener(v -> {
            CompanionApp.setThemeMode(this, CompanionApp.THEME_SYSTEM);
            updateThemeValueDisplay();
            dialog.dismiss();
        });

        optionLight.setOnClickListener(v -> {
            CompanionApp.setThemeMode(this, CompanionApp.THEME_LIGHT);
            updateThemeValueDisplay();
            dialog.dismiss();
        });

        optionDark.setOnClickListener(v -> {
            CompanionApp.setThemeMode(this, CompanionApp.THEME_DARK);
            updateThemeValueDisplay();
            dialog.dismiss();
        });

        // Configure dialog window for iOS-style bottom sheet appearance
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            dialog.getWindow().setGravity(Gravity.BOTTOM);
            dialog.getWindow().getAttributes().windowAnimations = R.style.DialogSlideAnimation;
        }

        dialog.show();
    }

    private void openPlayStoreForRating() {
        try {
            Uri uri = Uri.parse("market://details?id=" + getPackageName());
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Uri uri = Uri.parse("https://play.google.com/store/apps/details?id=" + getPackageName());
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        }
    }

    private void openMoreApps() {
        String moreAppsUrl = getString(R.string.more_apps_url);
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(moreAppsUrl));
        startActivity(intent);
    }

    private void openEmailClient() {
        String supportEmail = getString(R.string.support_email);
        String subject = getString(R.string.support_email_subject, getString(R.string.app_name));

        Intent intent = new Intent(Intent.ACTION_SENDTO);
        intent.setData(Uri.parse("mailto:" + supportEmail));
        intent.putExtra(Intent.EXTRA_SUBJECT, subject);

        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            // No email client installed
        }
    }

    private void shareApp() {
        String appName = getString(R.string.app_name);
        String playStoreUrl = "https://play.google.com/store/apps/details?id=" + getPackageName();
        String shareMessage = getString(R.string.share_message, appName, playStoreUrl);

        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, shareMessage);

        startActivity(Intent.createChooser(intent, getString(R.string.share_via)));
    }

    private void openPrivacyPolicy() {
        String policyUrl = getString(R.string.policy_url);
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(policyUrl));
        startActivity(intent);
    }

    private void setupVersionInfo() {
        TextView versionText = findViewById(R.id.version_text);
        try {
            PackageInfo packageInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            String versionName = packageInfo.versionName;
            versionText.setText(versionName);
        } catch (PackageManager.NameNotFoundException e) {
            versionText.setText("1.0.0");
        }
    }

    private void checkWatchAndShowRate() {
        View rateItem = findViewById(R.id.setting_rate);

        Wearable.getNodeClient(this).getConnectedNodes()
                .addOnSuccessListener(nodes -> {
                    for (Node node : nodes) {
                        if (node.isNearby()) {
                            rateItem.setVisibility(View.VISIBLE);
                            updateEngagementSectionVisibility();
                            return;
                        }
                    }
                    // No watch found - stays hidden
                    updateEngagementSectionVisibility();
                })
                .addOnFailureListener(e -> {
                    // API failed - stays hidden
                    updateEngagementSectionVisibility();
                });
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(R.anim.fade_in_subtle, R.anim.slide_down);
    }
}
