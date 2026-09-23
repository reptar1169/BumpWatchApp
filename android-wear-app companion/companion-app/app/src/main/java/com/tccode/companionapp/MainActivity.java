package com.tccode.companionapp;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.animation.Animation;
import android.view.animation.AnimationUtils;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.wear.remote.interactions.RemoteActivityHelper;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.imageview.ShapeableImageView;
import com.google.android.material.snackbar.Snackbar;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    // Views
    private View rootView;
    private SwipeRefreshLayout swipeRefreshLayout;
    private MaterialButton installButton;
    private Handler handler;

    // Hero section
    private View watchHeroContainer;
    private ShapeableImageView watchImage;
    private TextView appTitle;

    // Status section
    private View statusCard;
    private View connectionDot;
    private ImageView statusIcon;
    private TextView statusTitle;
    private TextView statusSubtitle;

    // Navigation
    private View navHome;
    private View navSettings;
    private View bottomNavCard;

    // Animation state
    private Animation floatAnimation;
    private Animation pulseAnimation;
    private boolean isConnected = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        setContentView(R.layout.activity_main);

        setupViews();
        setupWindowInsets();
        applyCustomPrimaryColor();
        setupSwipeRefresh();
        setupInstallButton();
        setupBottomNavigation();
        setupAnimations();

        // Start with views invisible for entrance animation
        prepareEntranceAnimation();

        checkWatchConnection();

        // Start entrance animation after a brief delay
        handler.postDelayed(this::playEntranceAnimation, 300);
    }

    private void setupViews() {
        rootView = findViewById(android.R.id.content);
        handler = new Handler(Looper.getMainLooper());

        // Hero section
        watchHeroContainer = findViewById(R.id.watch_hero_container);
        watchImage = findViewById(R.id.watch_image);
        appTitle = findViewById(R.id.app_title);

        // Status section
        statusCard = findViewById(R.id.status_card);
        connectionDot = findViewById(R.id.connection_dot);
        statusIcon = findViewById(R.id.status_icon);
        statusTitle = findViewById(R.id.status_title);
        statusSubtitle = findViewById(R.id.status_subtitle);

        // Main controls
        swipeRefreshLayout = findViewById(R.id.swipe_refresh_layout);
        installButton = findViewById(R.id.install_button);

        // Navigation
        navHome = findViewById(R.id.nav_home);
        navSettings = findViewById(R.id.nav_settings);
        bottomNavCard = findViewById(R.id.bottom_nav_card);
    }

    private void applyCustomPrimaryColor() {
        if (CompanionApp.hasCustomPrimaryColor()) {
            int primaryColor = CompanionApp.getCustomPrimaryColor();

            // Apply to install button
            installButton.setBackgroundTintList(ColorStateList.valueOf(primaryColor));

            // Apply to status icon (initial state - will be overridden by connection
            // status)
            if (statusIcon != null) {
                statusIcon.setImageTintList(ColorStateList.valueOf(primaryColor));
            }

            // Apply to bottom navigation selected state
            ImageView homeIcon = navHome.findViewById(R.id.nav_home_icon);
            TextView homeText = navHome.findViewById(R.id.nav_home_label);
            if (homeIcon != null)
                homeIcon.setImageTintList(ColorStateList.valueOf(primaryColor));
            if (homeText != null)
                homeText.setTextColor(primaryColor);
        }
    }

    private void setupWindowInsets() {
        View mainContent = findViewById(R.id.main_content);

        ViewCompat.setOnApplyWindowInsetsListener(mainContent, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
            v.setPadding(v.getPaddingLeft(), insets.top, v.getPaddingRight(), v.getPaddingBottom());
            return windowInsets;
        });

        ViewCompat.setOnApplyWindowInsetsListener(bottomNavCard, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
            v.setPadding(v.getPaddingLeft(), v.getPaddingTop(), v.getPaddingRight(), v.getPaddingBottom());
            androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams params = (androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) v
                    .getLayoutParams();
            params.bottomMargin = insets.bottom + 20;
            v.setLayoutParams(params);
            return windowInsets;
        });
    }

    private void setupSwipeRefresh() {
        // Apply custom color to swipe refresh if set
        if (CompanionApp.hasCustomPrimaryColor()) {
            int primaryColor = CompanionApp.getCustomPrimaryColor();
            swipeRefreshLayout.setProgressBackgroundColorSchemeColor(primaryColor);
            swipeRefreshLayout.setColorSchemeColors(Color.WHITE);
        } else {
            swipeRefreshLayout.setColorSchemeResources(R.color.md_theme_onPrimary);
            swipeRefreshLayout.setProgressBackgroundColorSchemeResource(R.color.md_theme_primary);
        }

        swipeRefreshLayout.setRefreshing(true);

        handler.postDelayed(() -> {
            swipeRefreshLayout.setRefreshing(false);
        }, 1500);

        swipeRefreshLayout.setOnRefreshListener(() -> {
            checkWatchConnection();

            handler.postDelayed(() -> {
                swipeRefreshLayout.setRefreshing(false);
            }, 1500);
        });
    }

    private void setupInstallButton() {
        // Add touch feedback animation
        installButton.setOnTouchListener((v, event) -> {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    animateButtonPress(v);
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    animateButtonRelease(v);
                    break;
            }
            return false;
        });

        installButton.setOnClickListener(v -> handleInstallButtonClick());
    }

    private void animateButtonPress(View view) {
        view.animate()
                .scaleX(0.96f)
                .scaleY(0.96f)
                .setDuration(100)
                .setInterpolator(new DecelerateInterpolator())
                .start();
    }

    private void animateButtonRelease(View view) {
        view.animate()
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(200)
                .setInterpolator(new OvershootInterpolator())
                .start();
    }

    private void setupBottomNavigation() {
        navHome.setOnClickListener(v -> {
            // Scroll to top and re-check watch connection
            swipeRefreshLayout.scrollTo(0, 0);
            checkWatchConnection();
        });

        navSettings.setOnClickListener(v -> openSettings());
    }

    private void setupAnimations() {
        // Load animations
        floatAnimation = AnimationUtils.loadAnimation(this, R.anim.float_animation);
        pulseAnimation = AnimationUtils.loadAnimation(this, R.anim.pulse_animation);
    }

    private void prepareEntranceAnimation() {
        // Set initial state for staggered entrance
        watchHeroContainer.setAlpha(0f);
        watchHeroContainer.setTranslationY(30f);

        appTitle.setAlpha(0f);
        appTitle.setTranslationY(20f);

        statusCard.setAlpha(0f);
        statusCard.setTranslationY(20f);

        installButton.setAlpha(0f);
        installButton.setTranslationY(20f);

        bottomNavCard.setAlpha(0f);
        bottomNavCard.setTranslationY(40f);
    }

    private void playEntranceAnimation() {
        int delay = 0;
        int staggerDelay = 100;

        // Watch hero - first and most prominent
        animateViewEntrance(watchHeroContainer, delay);
        delay += staggerDelay + 50;

        // Start floating animation after entrance
        handler.postDelayed(() -> {
            watchImage.startAnimation(floatAnimation);
        }, delay + 400);

        // App title
        animateViewEntrance(appTitle, delay);
        delay += staggerDelay;

        // Status card
        animateViewEntrance(statusCard, delay);
        delay += staggerDelay;

        // Install button
        animateViewEntrance(installButton, delay);
        delay += staggerDelay;

        // Bottom nav
        animateViewEntrance(bottomNavCard, delay);
    }

    private void animateViewEntrance(View view, int delay) {
        view.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(delay)
                .setDuration(400)
                .setInterpolator(new DecelerateInterpolator(1.5f))
                .start();
    }

    private void startConnectionPulse() {
        if (connectionDot != null && isConnected) {
            connectionDot.startAnimation(pulseAnimation);
        }
    }

    private void stopConnectionPulse() {
        if (connectionDot != null) {
            connectionDot.clearAnimation();
        }
    }

    private void updateConnectionStatus(boolean connected, String watchName, int watchCount) {
        isConnected = connected;

        if (connected) {
            // Update status title
            statusTitle.setText(R.string.status_card_title_connected);

            // Update subtitle with watch name
            if (watchCount > 1) {
                statusSubtitle.setText(getString(R.string.multiple_watches_connected, watchCount));
            } else {
                statusSubtitle.setText(watchName);
            }

            // Green dot
            GradientDrawable dotDrawable = (GradientDrawable) connectionDot.getBackground();
            dotDrawable.setColor(ContextCompat.getColor(this, R.color.status_connected));

            // Update icon tint to green
            statusIcon.setImageTintList(ColorStateList.valueOf(ContextCompat.getColor(this, R.color.status_connected)));

            // Start pulse animation
            startConnectionPulse();
        } else {
            // Update status
            statusTitle.setText(R.string.status_card_title_not_found);
            statusSubtitle.setText(R.string.status_card_hint_not_found);

            // Gray dot
            GradientDrawable dotDrawable = (GradientDrawable) connectionDot.getBackground();
            dotDrawable.setColor(ContextCompat.getColor(this, R.color.status_disconnected));

            // Update icon tint to gray
            statusIcon.setImageTintList(
                    ColorStateList.valueOf(ContextCompat.getColor(this, R.color.status_disconnected)));

            // Stop pulse
            stopConnectionPulse();
        }
    }

    private void handleInstallButtonClick() {
        Task<List<Node>> nodeListTask = Wearable.getNodeClient(this).getConnectedNodes();
        nodeListTask.addOnSuccessListener(nodes -> {
            List<Node> nearbyNodes = new ArrayList<>();
            for (Node node : nodes) {
                if (node.isNearby()) {
                    nearbyNodes.add(node);
                }
            }

            if (nearbyNodes.isEmpty()) {
                showNoWatchDialog();
            } else if (nearbyNodes.size() == 1) {
                installToWatch(nearbyNodes.get(0));
            } else {
                showWatchPickerDialog(nearbyNodes);
            }
        }).addOnFailureListener(e -> {
            showNoWatchDialog();
        });
    }

    private void showNoWatchDialog() {
        View dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_no_watch, null);

        AlertDialog dialog = new MaterialAlertDialogBuilder(this, R.style.ThemePickerDialogStyle)
                .setView(dialogView)
                .create();

        // Apply custom primary color to dialog buttons if set
        if (CompanionApp.hasCustomPrimaryColor()) {
            int primaryColor = CompanionApp.getCustomPrimaryColor();
            View btnOk = dialogView.findViewById(R.id.btn_ok);
            TextView btnLearnMore = dialogView.findViewById(R.id.btn_learn_more);
            if (btnOk instanceof com.google.android.material.button.MaterialButton) {
                ((com.google.android.material.button.MaterialButton) btnOk)
                        .setBackgroundTintList(ColorStateList.valueOf(primaryColor));
            }
            if (btnLearnMore != null) {
                btnLearnMore.setTextColor(primaryColor);
            }
        }

        // Setup buttons
        dialogView.findViewById(R.id.btn_ok).setOnClickListener(v -> dialog.dismiss());

        dialogView.findViewById(R.id.btn_learn_more).setOnClickListener(v -> {
            Intent intent = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://wearos.google.com/"));
            startActivity(intent);
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

    private void showWatchPickerDialog(List<Node> nodes) {
        View dialogView = LayoutInflater.from(this).inflate(R.layout.dialog_watch_picker, null);

        AlertDialog dialog = new MaterialAlertDialogBuilder(this, R.style.ThemePickerDialogStyle)
                .setView(dialogView)
                .create();

        // Add watch items dynamically
        LinearLayout watchListContainer = dialogView.findViewById(R.id.watch_list_container);

        for (int i = 0; i < nodes.size(); i++) {
            final Node node = nodes.get(i);

            View itemView = LayoutInflater.from(this).inflate(R.layout.item_watch_picker, watchListContainer, false);
            TextView watchName = itemView.findViewById(R.id.watch_name);
            watchName.setText(node.getDisplayName());

            itemView.setOnClickListener(v -> {
                installToWatch(node);
                dialog.dismiss();
            });

            watchListContainer.addView(itemView);
        }

        // Configure dialog window for iOS-style bottom sheet appearance
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            dialog.getWindow().setGravity(Gravity.BOTTOM);
            dialog.getWindow().getAttributes().windowAnimations = R.style.DialogSlideAnimation;
        }

        dialog.show();
    }

    private void installToWatch(Node node) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setData(Uri.parse("market://details?id=" + getPackageName()));

        RemoteActivityHelper helper = new RemoteActivityHelper(
                getApplicationContext(),
                Executors.newSingleThreadExecutor());

        helper.startRemoteActivity(intent, node.getId());

        // Show custom success snackbar
        showSuccessSnackbar(node.getDisplayName());
    }

    private void showSuccessSnackbar(String watchName) {
        // Inflate custom snackbar layout
        View snackbarView = LayoutInflater.from(this).inflate(R.layout.snackbar_success, null);

        TextView messageView = snackbarView.findViewById(R.id.snackbar_message);
        messageView.setText(getString(R.string.snackbar_success_message, watchName));

        // Create a custom snackbar using a popup-like behavior
        Snackbar snackbar = Snackbar.make(rootView, "", Snackbar.LENGTH_LONG);
        Snackbar.SnackbarLayout snackbarLayout = (Snackbar.SnackbarLayout) snackbar.getView();

        // Remove default text
        TextView textView = snackbarLayout.findViewById(com.google.android.material.R.id.snackbar_text);
        textView.setVisibility(View.INVISIBLE);

        // Make snackbar transparent
        snackbarLayout.setBackgroundColor(Color.TRANSPARENT);
        snackbarLayout.setPadding(0, 0, 0, 0);

        // Add custom view
        snackbarLayout.addView(snackbarView, 0);

        // Position above bottom nav
        snackbar.setAnchorView(bottomNavCard);

        snackbar.show();
    }

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
        overridePendingTransition(R.anim.slide_up, R.anim.fade_out_subtle);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Restart floating animation when returning
        if (watchImage != null && floatAnimation != null) {
            watchImage.startAnimation(floatAnimation);
        }
        // Restart pulse if connected
        if (isConnected) {
            startConnectionPulse();
        }
        // Re-check watch connection when returning to this screen
        checkWatchConnection();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Stop animations when paused
        if (watchImage != null) {
            watchImage.clearAnimation();
        }
        stopConnectionPulse();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
    }

    private void checkWatchConnection() {
        Task<List<Node>> nodeListTask = Wearable.getNodeClient(this).getConnectedNodes();
        nodeListTask.addOnSuccessListener(nodes -> {
            boolean connected = false;
            String connectedName = "";
            int connectedCount = 0;

            for (Node node : nodes) {
                if (node.isNearby()) {
                    connected = true;
                    connectedCount++;
                    if (connectedName.isEmpty()) {
                        connectedName = node.getDisplayName();
                    }
                }
            }

            final boolean isConnectedResult = connected;
            final String watchName = connectedName;
            final int watchCount = connectedCount;

            handler.postDelayed(() -> {
                updateConnectionStatus(isConnectedResult, watchName, watchCount);
            }, 1500);
        }).addOnFailureListener(e -> {
            handler.postDelayed(() -> {
                updateConnectionStatus(false, "", 0);
            }, 1500);
        });
    }
}
