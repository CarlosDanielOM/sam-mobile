package org.nativescript.nativesam.generation;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

public class GenerationForegroundService extends Service {
  public static final String CHANNEL_WORKING = "sam.generation.working";
  public static final String CHANNEL_DONE = "sam.generation.done";
  public static final String ACTION_START = "org.nativescript.nativesam.generation.START";
  public static final String ACTION_UPDATE = "org.nativescript.nativesam.generation.UPDATE";
  public static final String ACTION_COMPLETE = "org.nativescript.nativesam.generation.COMPLETE";
  public static final String ACTION_FAILED = "org.nativescript.nativesam.generation.FAILED";
  public static final String ACTION_STOP = "org.nativescript.nativesam.generation.STOP";
  public static final String ACTION_CANCEL = "org.nativescript.nativesam.generation.CANCEL";
  public static final String EXTRA_TITLE = "title";
  public static final String EXTRA_TEXT = "text";
  public static final String EXTRA_CONVERSATION_ID = "sam.conversationId";
  public static final String EXTRA_GENERATION_ID = "sam.generationId";
  public static final String EXTRA_SHOW_CANCEL = "showCancel";

  private static final int WORKING_ID = 1001;
  private static final int DONE_ID = 1002;
  private static final String TAG = "SAM-LIFECYCLE";

  private static GenerationServiceListener listener;

  public static void setListener(GenerationServiceListener next) {
    listener = next;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    Log.i(TAG, "foreground-service onCreate");
    createChannels();
  }

  @Override
  public void onDestroy() {
    Log.i(TAG, "foreground-service onDestroy");
    super.onDestroy();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null) {
      stopForeground(true);
      stopSelf();
      return START_NOT_STICKY;
    }
    String action = intent.getAction();
    if (ACTION_CANCEL.equals(action)) {
      String generationId = intent.getStringExtra(EXTRA_GENERATION_ID);
      if (listener != null && generationId != null && !generationId.trim().isEmpty()) {
        listener.onCancel(generationId);
      }
      return START_NOT_STICKY;
    }
    if (ACTION_STOP.equals(action)) {
      stopWorking();
      return START_NOT_STICKY;
    }
    if (ACTION_COMPLETE.equals(action) || ACTION_FAILED.equals(action)) {
      boolean failed = ACTION_FAILED.equals(action);
      postDone(intent, failed);
      stopWorking();
      return START_NOT_STICKY;
    }
    Notification working = buildWorking(intent);
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(WORKING_ID, working, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(WORKING_ID, working);
    }
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void stopWorking() {
    if (Build.VERSION.SDK_INT >= 24) {
      stopForeground(Service.STOP_FOREGROUND_REMOVE);
    } else {
      stopForeground(true);
    }
    stopSelf();
  }

  private void createChannels() {
    if (Build.VERSION.SDK_INT < 26) {
      return;
    }
    NotificationManager manager = manager();
    NotificationChannel working =
        new NotificationChannel(CHANNEL_WORKING, "SAM working", NotificationManager.IMPORTANCE_LOW);
    working.setDescription("Active SAM generations");
    working.setShowBadge(false);
    manager.createNotificationChannel(working);
    NotificationChannel done =
        new NotificationChannel(CHANNEL_DONE, "SAM responses", NotificationManager.IMPORTANCE_DEFAULT);
    done.setDescription("Completed or failed SAM generations");
    manager.createNotificationChannel(done);
  }

  private Notification buildWorking(Intent intent) {
    String title = extra(intent, EXTRA_TITLE, "SAM is thinking…");
    String text = extra(intent, EXTRA_TEXT, "");
    String conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
    String generationId = intent.getStringExtra(EXTRA_GENERATION_ID);
    boolean showCancel = intent.getBooleanExtra(EXTRA_SHOW_CANCEL, false);
    Notification.Builder builder = notificationBuilder(CHANNEL_WORKING);
    builder
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openChat(conversationId, 11));
    if (showCancel && generationId != null && !generationId.trim().isEmpty()) {
      Intent cancel = new Intent(this, GenerationForegroundService.class);
      cancel.setAction(ACTION_CANCEL);
      // Extras do not identify PendingIntents; keep stale cancels scoped to their generation.
      cancel.setData(new Uri.Builder().scheme("sam").authority("generation")
          .appendPath(generationId).build());
      cancel.putExtra(EXTRA_GENERATION_ID, generationId);
      PendingIntent cancelIntent =
          PendingIntent.getService(this, 21, cancel, pendingFlags());
      builder.addAction(
          new Notification.Action.Builder(
                  android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent)
              .build());
    }
    return builder.build();
  }

  private void postDone(Intent intent, boolean failed) {
    String title = extra(intent, EXTRA_TITLE, failed ? "SAM couldn't finish the response" : "SAM finished responding");
    String text = extra(intent, EXTRA_TEXT, "");
    String conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
    Notification.Builder builder = notificationBuilder(CHANNEL_DONE);
    builder
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setAutoCancel(true)
        .setContentIntent(openChat(conversationId, failed ? 32 : 31));
    manager().notify(DONE_ID, builder.build());
  }

  private Notification.Builder notificationBuilder(String channelId) {
    if (Build.VERSION.SDK_INT >= 26) {
      return new Notification.Builder(this, channelId);
    }
    return new Notification.Builder(this);
  }

  private PendingIntent openChat(String conversationId, int requestCode) {
    Intent launch = new Intent();
    launch.setClassName(this, "com.tns.NativeScriptActivity");
    launch.setAction(Intent.ACTION_MAIN);
    launch.addCategory(Intent.CATEGORY_LAUNCHER);
    launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
    if (conversationId != null) {
      launch.putExtra(EXTRA_CONVERSATION_ID, conversationId);
    }
    return PendingIntent.getActivity(this, requestCode, launch, pendingFlags());
  }

  private int pendingFlags() {
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= 23) {
      flags |= PendingIntent.FLAG_IMMUTABLE;
    }
    return flags;
  }

  private NotificationManager manager() {
    return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
  }

  private static String extra(Intent intent, String key, String fallback) {
    String value = intent.getStringExtra(key);
    return value == null || value.length() == 0 ? fallback : value;
  }
}
