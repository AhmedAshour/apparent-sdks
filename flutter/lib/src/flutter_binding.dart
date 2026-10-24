import 'dart:async';
import 'dart:io' show Directory, Platform;
import 'dart:ffi' show Abi;
import 'dart:ui' show ErrorCallback;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import 'client.dart';
import 'storage.dart';

/// Apparent for Flutter apps.
///
///     await Apparent.start(app: 'einb', key: '<write key>', disabled: kDebugMode);
///     Apparent.track('paywall_view', {'source': 'onboarding'});
///     MaterialApp(navigatorObservers: [ApparentNavigatorObserver()], …)
class Apparent {
  Apparent._();

  static ApparentClient? _client;
  static AppLifecycleListener? _lifecycle;

  /// The client behind the static calls (null before [start]).
  static ApparentClient? get client => _client;

  /// Start once, as early as you can (in `main()`). Calls `WidgetsFlutterBinding.ensureInitialized()`.
  /// The returned future finishes once saved ids and events are loaded; you don't need to wait for it.
  static Future<void> start({
    required String app,
    required String key,
    String apiUrl = 'https://in.apparent.fyi',
    bool disabled = false,
    bool debug = false,
    String? userId,
    Future<String?> Function()? anonymousId,
    Duration sessionTimeout = const Duration(minutes: 30),
    bool captureErrors = true,
    ApparentEvent? Function(ApparentEvent event)? beforeSend,
    bool optOutByDefault = false,
    bool trackDeepLinks = true,
    bool trackPushOpens = true,
  }) async {
    if (_client != null) return _client!.ready();
    final binding = WidgetsFlutterBinding.ensureInitialized();
    final client = ApparentClient(
      storage: kIsWeb ? MemoryStorage() : FileStorage(_folder),
      device: ApparentDevice(platform: _platform()),
    );
    final cfg = ApparentConfig(
      app: app,
      key: key,
      apiUrl: apiUrl,
      disabled: disabled,
      debug: debug,
      userId: userId,
      anonymousId: anonymousId,
      sessionTimeout: sessionTimeout,
      captureErrors: captureErrors,
      beforeSend: beforeSend,
      optOutByDefault: optOutByDefault,
      trackDeepLinks: trackDeepLinks,
      trackPushOpens: trackPushOpens,
    );
    // The app version is part of the saved state (app_updated), so the phone is read before the saved state.
    return _attach(client, cfg, binding, readDevice());
  }

  static Future<void> _attach(ApparentClient client, ApparentConfig cfg, WidgetsBinding binding, Future<ApparentDevice>? device) {
    client.start(cfg, appState: _state(binding.lifecycleState), deviceInfo: device);
    // Without an app id or key the client ignores it: so does Apparent, and a later correct start still works.
    if (client.config == null) return Future.value();
    _client = client;
    _lifecycle = AppLifecycleListener(binding: binding, onStateChange: (s) => client.setAppState(_state(s)));
    if (cfg.captureErrors && !cfg.disabled) _installErrorHandlers();
    return client.ready();
  }

  /// For tests: start with your own client (fake storage and HTTP), wired to Flutter like [start].
  @visibleForTesting
  static Future<void> startWith(ApparentClient client, ApparentConfig cfg) {
    if (_client != null) return _client!.ready();
    return _attach(client, cfg, WidgetsFlutterBinding.ensureInitialized(), null);
  }

  static Future<Directory> _folder() async => Directory('${(await getApplicationSupportDirectory()).path}/apparent');

  /// Record something a person did. Names: lowercase_snake. Props: flat values (string, number, bool, null).
  static void track(String name, [Map<String, Object?>? props]) => _client?.track(name, props);

  /// Record that a screen was shown. [ApparentNavigatorObserver] calls it for you.
  static void screen(String name, [Map<String, Object?>? props]) => _client?.screen(name, props);

  /// Properties added to every event from now on. `null` removes one.
  static void setProperties(Map<String, Object?>? props) => _client?.setProperties(props);

  static void unsetProperty(String key) => _client?.unsetProperty(key);

  /// A link opened the app: sends `deep_link_opened` with the link (secrets redacted) and its `utm_` fields.
  /// Flutter can't see links by itself; pass them from your link package, once per link:
  /// `AppLinks().uriLinkStream.listen(Apparent.trackDeepLink)` (it also gives the link the app was launched with).
  static void trackDeepLink(Object? link) => _client?.trackDeepLink(link);

  /// Someone tapped a notification: sends `push_opened` with only `campaign` and `title` from its [data], never the
  /// text people saw. With firebase_messaging, from `getInitialMessage()` and `onMessageOpenedApp`:
  /// `Apparent.trackPushOpened(message.data, id: message.messageId)`.
  static void trackPushOpened(Map<String, Object?>? data, {String? id}) => _client?.trackPushOpened(data, id: id);

  /// Who is using the app, once they log in.
  static void identify(String? userId) => _client?.identify(userId);

  /// Someone logged out: forget who they were and start a new anonymous id.
  static void logout() => _client?.logout();

  /// The same as [logout] (the name the other Apparent SDKs use).
  static void reset() => _client?.logout();

  /// Report an error you caught yourself.
  static void captureError(Object error, {StackTrace? stack, bool fatal = false, Map<String, Object?>? extra}) =>
      _client?.captureError(error, stack: stack, fatal: fatal, extra: extra);

  /// Stop collecting (remembered across launches).
  static void optOut() => _client?.optOut();

  /// Start collecting again, or for the first time with `optOutByDefault: true` (remembered across launches).
  static void optIn() => _client?.optIn();

  static bool get isOptedOut => _client?.isOptedOut ?? false;

  /// This install's id (also on RevenueCat as `apparent_id` after [linkRevenueCat]).
  static String? get anonymousId => _client?.anonymousId;

  /// `await Apparent.linkRevenueCat((attrs) => Purchases.setAttributes(attrs));`
  static Future<void> linkRevenueCat(FutureOr<void> Function(Map<String, String> attributes) setAttributes) =>
      _client?.linkRevenueCat(setAttributes) ?? Future.value();

  /// Send what is queued now. It also happens every 10 s, at 20 events, and when the app goes to the background.
  static Future<void> flush() => _client?.flush() ?? Future.value();

  /// For tests and hot restart: stop and forget the client.
  @visibleForTesting
  static Future<void> stop() async {
    _lifecycle?.dispose();
    _lifecycle = null;
    await _client?.shutdown();
    _client = null;
  }
}

ApparentAppState _state(AppLifecycleState? s) => switch (s) {
      AppLifecycleState.paused || AppLifecycleState.hidden || AppLifecycleState.detached => ApparentAppState.background,
      AppLifecycleState.inactive => ApparentAppState.inactive,
      // null = the first frame hasn't asked yet: a normal launch.
      AppLifecycleState.resumed || null => ApparentAppState.active,
    };

String _platform() {
  if (kIsWeb) return 'web';
  return Platform.operatingSystem; // ios, android, macos, windows, linux
}

/// The phone, named the way the Expo SDK names it: iOS version or Android API level, the hardware model
/// ("iPhone15,2", "Pixel 8"), the app's version and build, the locale and region. No advertising ids.
Future<ApparentDevice> readDevice() async {
  String? os, model, app, build;
  var simulator = false;
  try {
    final info = await PackageInfo.fromPlatform();
    app = info.version.isEmpty ? null : info.version;
    build = info.buildNumber.isEmpty ? null : info.buildNumber;
  } catch (_) {}
  try {
    final d = DeviceInfoPlugin();
    if (!kIsWeb && Platform.isIOS) {
      final i = await d.iosInfo;
      os = i.systemVersion;
      // In the Simulator: the Mac's processor ("arm64"), as the Expo SDK reports it; Apparent counts it as a test phone.
      model = i.isPhysicalDevice ? i.utsname.machine : (Abi.current() == Abi.iosX64 ? 'x86_64' : 'arm64');
      simulator = !i.isPhysicalDevice;
    } else if (!kIsWeb && Platform.isAndroid) {
      final a = await d.androidInfo;
      os = '${a.version.sdkInt}';
      model = a.model;
      simulator = !a.isPhysicalDevice;
    } else if (!kIsWeb && Platform.isMacOS) {
      final m = await d.macOsInfo;
      os = '${m.majorVersion}.${m.minorVersion}';
      model = m.model;
    }
  } catch (_) {}
  final locale = PlatformDispatcher.instance.locale;
  final region = locale.countryCode;
  return ApparentDevice(
    platform: _platform(),
    os: os,
    app: app,
    build: build,
    model: model == null || model.isEmpty ? null : model,
    locale: locale.toLanguageTag() == 'und' ? null : locale.toLanguageTag(),
    region: region == null || region.isEmpty ? null : region,
    // Dart has no IANA time zone name ("Europe/Berlin") without a plugin; the server doesn't read it.
    tz: null,
    simulator: simulator,
  );
}

FlutterExceptionHandler? _ourFlutterHandler;
ErrorCallback? _ourDispatcherHandler;

/// Flutter's errors (build, layout, gestures) and Dart's uncaught ones are saved to the phone at once, so they arrive
/// even if the app is killed right after (they go with the next send, at the latest on the next launch). The handlers
/// that were there before (yours, Crashlytics, Sentry) still run. Set yours before or after `Apparent.start`: if you set
/// it after, call the previous one (`FlutterError.onError`) from yours to keep Apparent's.
void _installErrorHandlers() {
  if (_ourFlutterHandler == null || FlutterError.onError != _ourFlutterHandler) {
    final previous = FlutterError.onError;
    _ourFlutterHandler = (details) {
      try {
        final client = Apparent._client;
        if (client != null && !details.silent) {
          client.captureError(details.exception, stack: details.stack, how: 'uncaught');
          client.persistNow();
        }
      } catch (_) {/* never make it worse */}
      (previous ?? FlutterError.presentError)(details);
    };
    FlutterError.onError = _ourFlutterHandler;
  }
  final dispatcher = PlatformDispatcher.instance;
  if (_ourDispatcherHandler == null || dispatcher.onError != _ourDispatcherHandler) {
    final previous = dispatcher.onError;
    _ourDispatcherHandler = (error, stack) {
      try {
        Apparent._client?.captureError(error, stack: stack, how: 'uncaught');
        Apparent._client?.persistNow();
      } catch (_) {}
      return previous?.call(error, stack) ?? false;
    };
    dispatcher.onError = _ourDispatcherHandler;
  }
}

/// Records a `screen_view` for each page route that comes to the top: `MaterialApp(navigatorObservers: [ApparentNavigatorObserver()])`.
/// The screen is the route's name (`RouteSettings.name`, e.g. "/settings" → "settings", "/" → "home", like the Expo
/// router's names). Routes without a name, dialogs and sheets are skipped unless [screenName] names them.
class ApparentNavigatorObserver extends NavigatorObserver {
  ApparentNavigatorObserver({this.screenName});

  /// Your own naming: return null to skip a route.
  final String? Function(Route<dynamic> route)? screenName;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _show(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (newRoute != null) _show(newRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null) _show(previousRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null && previousRoute.isCurrent) _show(previousRoute);
  }

  void _show(Route<dynamic> route) {
    final name = screenName != null ? screenName!(route) : defaultScreenName(route);
    if (name != null && name.isNotEmpty) Apparent.screen(name);
  }
}

/// "/practice/recht" → "practice/recht", "/" → "home"; unnamed routes and popups (dialogs, sheets) → null.
String? defaultScreenName(Route<dynamic> route) {
  if (route is! PageRoute) return null;
  final raw = route.settings.name;
  if (raw == null) return null;
  final path = raw.split('?').first.replaceAll(RegExp(r'^/+|/+$'), '');
  return path.isEmpty ? 'home' : path;
}
