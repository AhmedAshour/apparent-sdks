// The Apparent client: pure Dart, no Flutter. The same rules as the Expo SDK (sdk/expo/src/index.ts):
// - every event is saved to the phone within a quarter second, and right away when the app goes to the background or an
//   error is caught;
// - one batch is sent at a time, and a batch only leaves the saved queue once the server has it;
// - each request has a time limit, and retries wait longer each time (and honour Retry-After exactly);
// - the batch carries the phone's clock, so the server can correct phones set to the wrong time; it ignores duplicates.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show parseHttpDate;

import 'storage.dart';

/// Sent as `v` in every batch, so the server can tell the SDKs apart.
const sdkVersion = 'flutter-0.3.1';

const _storageKey = 'apparent:v2';
const _maxEventAgeMs = 7 * 24 * 3600 * 1000;
const _maxErrorsPerVisit = 20;
const _maxBatch = 100;
const _maxProps = 40;
const _maxValue = 500;

/// A disk that never answers must not hold sending or ready(): stop waiting for a write after this (it goes on).
const _writeWait = Duration(seconds: 1);

final _random = Random.secure();

String _uid() {
  const hex = '0123456789abcdef';
  final b = StringBuffer();
  for (var i = 0; i < 32; i++) {
    b.write(hex[_random.nextInt(16)]);
  }
  return b.toString();
}

int _nowMs() => DateTime.now().millisecondsSinceEpoch;

/// Milliseconds that only ever go forward (the phone's clock can be changed; this can't). For retry waits.
final Stopwatch _monotonic = Stopwatch()..start();
int _monotonicMs() => _monotonic.elapsedMilliseconds;

bool _isText(Object? v, [int max = 128]) => v is String && v.trim().isNotEmpty && v.length <= max;

String _cut(String s, int max) => s.length > max ? s.substring(0, max) : s;

/// What the phone is: sent once per batch as `d`.
class ApparentDevice {
  const ApparentDevice({
    required this.platform,
    this.os,
    this.app,
    this.build,
    this.model,
    this.locale,
    this.region,
    this.tz,
    this.simulator = false,
  });

  /// "ios", "android", "web", "macos"…
  final String platform;

  /// iOS version ("18.0") or Android API level ("34"), like React Native's Platform.Version.
  final String? os;
  final String? app;
  final String? build;

  /// "iPhone15,2", "Pixel 8"; the iOS Simulator reports the Mac's processor ("arm64").
  final String? model;
  final String? locale;
  final String? region;
  final String? tz;

  /// Running in the iOS Simulator or an Android emulator. Sent only when true, so Apparent leaves it out of the counts.
  final bool simulator;

  Map<String, Object?> toJson() => {
        'platform': platform,
        'os': os ?? '',
        'app': app,
        'build': build,
        'model': model,
        'locale': locale,
        'region': region,
        'tz': tz,
        if (simulator) 'simulator': true,
      };
}

/// Where the app is: in front, half hidden (a call, the app switcher), or in the background.
enum ApparentAppState { active, inactive, background }

/// The config behind `Apparent.start`. Most fields are for tests.
class ApparentConfig {
  const ApparentConfig({
    required this.app,
    required this.key,
    this.apiUrl = 'https://in.apparent.fyi',
    this.disabled = false,
    this.debug = false,
    this.userId,
    this.anonymousId,
    this.sessionTimeout = const Duration(minutes: 30),
    this.captureErrors = true,
    this.flushInterval = const Duration(seconds: 10),
    this.flushAt = 20,
    this.maxQueue = 1000,
    this.requestTimeout = const Duration(seconds: 10),
    this.retryBase = const Duration(seconds: 2),
    this.beforeSend,
    this.optOutByDefault = false,
    this.trackDeepLinks = true,
    this.trackPushOpens = true,
  });

  /// The app's id in Apparent ("einb").
  final String app;

  /// The app's write key (Apparent › the app › SDK).
  final String key;
  final String apiUrl;

  /// Nothing is stored or sent. Use it in development (`disabled: kDebugMode`).
  final bool disabled;
  final bool debug;
  final String? userId;

  /// A stable id you already have (an install id, the RevenueCat app user id) so events and purchases join.
  /// Asked once, on the first launch.
  final Future<String?> Function()? anonymousId;

  /// Time in the background before a visit ends.
  final Duration sessionTimeout;

  /// Report Flutter and Dart errors. Default true.
  final bool captureErrors;
  final Duration flushInterval;
  final int flushAt;
  final int maxQueue;
  final Duration requestTimeout;
  final Duration retryBase;

  /// Runs on every event (automatic ones too) before it is queued, after its properties are cleaned. Return the event,
  /// changed, or null to drop it. Use it to remove personal data or skip noisy events. If it throws, the event is kept.
  final ApparentEvent? Function(ApparentEvent event)? beforeSend;

  /// Collect nothing until `optIn()` is called (for apps that ask for consent first). Remembered across launches.
  final bool optOutByDefault;

  /// Send `deep_link_opened` for the links you pass to `trackDeepLink`. Default true.
  final bool trackDeepLinks;

  /// Send `push_opened` for the notifications you pass to `trackPushOpened`. Default true.
  final bool trackPushOpens;

  /// The same config with numbers that can't work replaced by the defaults (a zero interval would spin, a negative
  /// queue size would throw).
  ApparentConfig _sane() => ApparentConfig(
        app: app.trim(),
        key: key.trim(),
        apiUrl: apiUrl.trim(),
        disabled: disabled,
        debug: debug,
        userId: userId,
        anonymousId: anonymousId,
        sessionTimeout: sessionTimeout.isNegative ? const Duration(minutes: 30) : sessionTimeout,
        captureErrors: captureErrors,
        flushInterval: flushInterval.inMilliseconds < 100 ? const Duration(seconds: 10) : flushInterval,
        flushAt: flushAt < 1 ? 20 : flushAt,
        maxQueue: maxQueue < 1 ? 1000 : maxQueue,
        requestTimeout: requestTimeout.inMilliseconds < 100 ? const Duration(seconds: 10) : requestTimeout,
        retryBase: retryBase.isNegative ? const Duration(seconds: 2) : retryBase,
        beforeSend: beforeSend,
        optOutByDefault: optOutByDefault,
        trackDeepLinks: trackDeepLinks,
        trackPushOpens: trackPushOpens,
      );
}

/// An event as `beforeSend` sees it. Change [name] or [props] and return it, or return null to drop it.
class ApparentEvent {
  ApparentEvent({required this.name, this.props, required this.time});

  String name;

  /// Flat values (string, number, bool, null), the app's properties from `setProperties` included.
  Map<String, Object?>? props;

  /// When it happened (the phone's clock).
  final DateTime time;
}

/// Printed once in debug builds when the server answers 401.
const wrongKeyWarning = 'Apparent: app id or key is wrong — events are not being saved';

/// True in debug builds (asserts only run there), without needing Flutter in this file.
bool _debugBuild() {
  var on = false;
  assert(on = true);
  return on;
}

/// What an event tracked before the saved state was read still needs: its own properties, and whether a logout or a
/// sign-in had already happened (then the saved user and properties aren't its).
class _Early {
  _Early(this.name, this.props, this.afterReset, this.afterIdentify);
  final String name;
  final Map<String, Object?> props;
  final bool afterReset;
  final bool afterIdentify;
}

/// A queued event. `a`/`u` = whose event it is at the moment it was tracked (identity can change before it is sent).
class _Queued {
  _Queued(this.n, this.t, this.s, this.i, this.p, this.a, this.u);

  String n;
  final int t;
  final String s;
  final String i;
  Map<String, Object?>? p;
  String a;
  String? u;

  /// Set while the saved state hasn't been read yet (in memory only, never saved).
  _Early? early;

  Map<String, Object?> toJson() => {
        'n': n,
        't': t,
        's': s,
        'i': i,
        if (p != null) 'p': p,
        'a': a,
        'u': u,
      };

  /// A saved event, or null when it is missing its name, time, session or insert id (another version, a bad write).
  static _Queued? fromJson(Object? j, String anon) {
    if (j is! Map) return null;
    final n = j['n'], t = j['t'], s = j['s'], i = j['i'], a = j['a'], u = j['u'], p = j['p'];
    if (!_isText(n, 80) || t is! num || !t.isFinite || !_isText(s, 64) || !_isText(i, 80)) return null;
    return _Queued(n as String, t.toInt(), s as String, i as String, _cleanProps(_stringKeys(p)), _isText(a) ? a as String : anon,
        _isText(u) ? u as String : null);
  }
}

enum _Kind { ok, drop, tooLarge, network, server }

class _SendResult {
  const _SendResult(this.kind, {this.status, this.retryAfterMs});
  final _Kind kind;
  final int? status;
  final int? retryAfterMs;
}

/// A value the server can store: string (max 500), number, bool or null. Anything else is turned into JSON text.
/// `absent` (returned for nothing) means "leave the key out".
const _absent = Object();

/// One property value, flat. Never throws: a date is its ISO time, a function or symbol is left out ([_absent]),
/// anything else is its JSON text, or its toString() when that fails, or null when both fail.
Object? _cleanValue(Object? v) {
  if (v == null || v is bool) return v;
  if (v is Function || v is Symbol) return _absent;
  if (v is num) return v.isFinite ? v : null;
  if (v is String) return _cut(v, _maxValue);
  if (v is DateTime) return DateTime.fromMillisecondsSinceEpoch(v.millisecondsSinceEpoch, isUtc: true).toIso8601String();
  if (v is BigInt) return _cut(v.toString(), _maxValue);
  if (v is Enum) return v.name;
  String? s;
  try {
    s = jsonEncode(v);
  } catch (_) {
    s = null;
  }
  if (s == null) {
    try {
      s = v.toString();
    } catch (_) {
      return null;
    }
  }
  return _cut(s, _maxValue);
}

/// A map's entries, or none when reading it throws (a map class of the app's own, a lazy view).
List<MapEntry<String, Object?>> _entriesOf(Map<String, Object?>? input) {
  if (input == null) return const [];
  try {
    return input.entries.toList();
  } catch (_) {
    return const [];
  }
}

Map<String, Object?> _readProps(Map<String, Object?>? input) => Map.fromEntries(_entriesOf(input));

/// A decoded JSON map with text keys, or null.
Map<String, Object?>? _stringKeys(Object? m) => m is Map ? m.map((k, v) => MapEntry('$k', v)) : null;

Map<String, Object?>? _cleanProps(Map<String, Object?>? input) {
  final entries = _entriesOf(input);
  if (entries.isEmpty) return null;
  final out = <String, Object?>{};
  var n = 0;
  for (final entry in entries) {
    if (identical(entry.value, _absent)) continue;
    final v = _cleanValue(entry.value);
    if (identical(v, _absent)) continue;
    if (n >= _maxProps) break;
    out[_cut(entry.key, 64)] = v;
    n++;
  }
  return n > 0 ? out : null;
}

/// Query and fragment parameters whose values are never sent: anything that looks like a login or a secret.
final _secretParam = RegExp('token|code|password|passwd|secret|key|auth|session|sig', caseSensitive: false);
final _utmParam = RegExp(r'^utm_(source|medium|campaign)$', caseSensitive: false);

/// A link that opened the app, safe to store (the Expo SDK's `cleanDeepLink`): secrets in the query or fragment become
/// "[redacted]", a user:password@ is dropped, and the whole string is cut to 500 characters. Also has the utm_ campaign
/// fields (`utm_source`, `utm_medium`, `utm_campaign`) when the link has them.
Map<String, String> cleanDeepLink(String raw) {
  var url = raw.replaceFirstMapped(RegExp(r'^([a-z][a-z0-9+.-]*://)[^/?#@]*@', caseSensitive: false), (m) => m[1]!);
  final utm = <String, String>{};
  String scrub(String part) => part.split('&').map((pair) {
        final eq = pair.indexOf('=');
        if (eq < 0) return pair;
        final k = pair.substring(0, eq);
        var name = k;
        try {
          name = Uri.decodeComponent(k);
        } catch (_) {/* keep as is */}
        final v = pair.substring(eq + 1);
        if (_utmParam.hasMatch(name)) {
          var value = v;
          try {
            value = Uri.decodeComponent(v.replaceAll('+', ' '));
          } catch (_) {/* keep as is */}
          if (value.isNotEmpty) utm[name.toLowerCase()] = _cut(value, 100);
          return pair;
        }
        return _secretParam.hasMatch(name) ? '$k=[redacted]' : pair;
      }).join('&');
  final hash = url.indexOf('#');
  var fragment = '';
  if (hash >= 0) {
    fragment = url.substring(hash + 1);
    url = url.substring(0, hash);
  }
  final q = url.indexOf('?');
  if (q >= 0) url = '${url.substring(0, q)}?${scrub(url.substring(q + 1))}';
  if (hash >= 0) url += '#${fragment.contains('=') ? scrub(fragment) : fragment}';
  return {'url': _cut(url, _maxValue), ...utm};
}

/// Retry-After as seconds or an HTTP date, kept between 1 s and 1 h.
int? retryAfterMs(String? header, {int Function() now = _nowMs}) {
  if (header == null || header.isEmpty) return null;
  final secs = num.tryParse(header.trim());
  int? ms;
  if (secs != null) {
    if (!secs.isFinite) return null;
    ms = (secs * 1000).round();
  } else {
    try {
      ms = parseHttpDate(header).millisecondsSinceEpoch - now();
    } catch (_) {
      return null;
    }
  }
  return min(3600000, max(1000, ms));
}

/// The "error" event's fields for something thrown, named like the Expo SDK names JavaScript errors.
Map<String, Object?> errorFields(Object error, StackTrace? stack) {
  String type;
  String message;
  if (error is String) {
    type = 'Error';
    message = error;
  } else {
    type = error.runtimeType.toString().replaceFirst(RegExp(r'^_+'), '');
    try {
      message = error.toString();
    } catch (_) {
      message = type;
    }
    if (message.startsWith('Exception: ')) message = message.substring(11);
    if (message == 'Exception') message = type;
  }
  String raw;
  try {
    raw = stack?.toString() ?? '';
  } catch (_) {
    raw = '';
  }
  final lines = raw
      .split('\n')
      .map((l) => l.trim())
      .where((l) => l.isNotEmpty)
      .take(8)
      .join('\n');
  return {
    'message': _cut(message.isEmpty ? type : message, 300),
    'type': type.isEmpty ? 'Error' : type,
    if (lines.isNotEmpty) 'stack': _cut(lines, 1500),
  };
}

/// The saved state, read field by field: what is valid is kept, the rest starts fresh (SPEC 4).
class _Saved {
  String? anon;
  String anonSource = 'own';
  String? userId;
  Map<String, Object?> props = {};
  bool optedOut = false;

  /// optIn() was called: with optOutByDefault, only then is anything collected. Saved only once it is true.
  bool consent = false;
  String? app;
  List<_Queued> queue = [];

  static _Saved? from(Object? raw) {
    if (raw is! Map) return null;
    final out = _Saved();
    if (_isText(raw['anon'])) out.anon = raw['anon'] as String;
    final source = raw['anonSource'];
    if (source == 'provider' || source == 'reset') out.anonSource = source as String;
    if (_isText(raw['userId'])) out.userId = raw['userId'] as String;
    out.props = _cleanProps(_stringKeys(raw['props'])) ?? {};
    out.optedOut = raw['optedOut'] == true;
    // optIn() with optOutByDefault: dropping it here would forget someone's consent on every launch.
    out.consent = raw['consent'] == true;
    if (_isText(raw['app'])) out.app = raw['app'] as String;
    final q = raw['queue'];
    if (q is List) {
      for (final e in q) {
        final ev = _Queued.fromJson(e, out.anon ?? '');
        if (ev != null) out.queue.add(ev);
      }
    }
    return out;
  }
}

class ApparentClient {
  /// [storage], [httpClient] and [device] are what `Apparent.start` fills in; tests pass fakes.
  /// [now] (the phone's clock, ms), [elapsed] (a clock that only goes forward, ms) and [random] are for tests too.
  ApparentClient({
    ApparentStorage? storage,
    http.Client? httpClient,
    this.device = const ApparentDevice(platform: 'unknown'),
    bool? debugBuild,
    void Function(String message)? warn,
    int Function()? now,
    int Function()? elapsed,
    double Function()? random,
  })  : _storage = storage ?? MemoryStorage(),
        _http = httpClient ?? http.Client(),
        _debugBuildOn = debugBuild ?? _debugBuild(),
        _warn = warn ?? _printWarning,
        _now = now ?? _nowMs,
        _elapsed = elapsed ?? _monotonicMs,
        _rand = random ?? _random.nextDouble;

  final bool _debugBuildOn;
  final void Function(String message) _warn;
  final int Function() _now;
  final int Function() _elapsed;
  final double Function() _rand;
  bool _warnedKey = false;
  bool _warnedHook = false;
  bool _resetBeforeLoad = false;
  bool _identifiedBeforeLoad = false;

  /// optIn() or optOut() before the saved state was read: that choice wins over the saved one.
  String? _consentBeforeLoad;
  bool _consented = false;

  /// optOutByDefault, before the saved state says whether they agreed: events are held in memory only, and dropped
  /// when it turns out they didn't.
  bool _waitingForConsent = false;
  final List<String> _recentPushes = [];

  // ignore: avoid_print
  static void _printWarning(String m) => print(m);

  final ApparentStorage _storage;
  final http.Client _http;
  ApparentDevice device;

  ApparentConfig? _cfg;
  String _anon = '';
  String _anonSource = 'own';
  String? _userId;
  Map<String, Object?> _props = {};
  bool _optedOut = false;
  String? _appVersion;
  List<_Queued> _queue = [];
  List<_Queued> _inflight = [];
  String _sessionId = _uid();
  Future<void> _loading = Future.value();
  bool _loaded = false;
  Future<void>? _sending;
  bool _sendAgain = false;
  int _failures = 0;

  /// The current retry wait: how long, and when it started on both clocks (see [_due]).
  int _retryWait = 0;
  int _retryFromElapsed = 0;
  int _retryFromNow = 0;
  _Kind? _retryReason;
  int _batchSize = _maxBatch;
  Timer? _persistTimer;
  Timer? _interval;
  ApparentAppState _appState = ApparentAppState.active;
  int? _activeSince;
  int? _backgroundAt;
  bool _pendingOpen = false;
  String? _screenName;
  int _errorsThisVisit = 0;

  ApparentConfig? get config => _cfg;

  /// How long the SDK waits before it tries to send again after a failure (0 = not waiting). For tests.
  int get retryWaitMs => _retryWait;

  /// Start once. [appState] is where the app is now: a launch in the background (a silent push, a background fetch) is
  /// not a visit, so app_open waits until the app is really in front.
  /// [deviceInfo], when given, replaces [device] before the saved state is read (the app version decides app_updated).
  /// Events tracked in the meantime are kept. A config without an app id, key or intake address is ignored (a warning
  /// in debug builds), so a later correct `start` still works.
  void start(ApparentConfig cfg, {ApparentAppState appState = ApparentAppState.active, Future<ApparentDevice>? deviceInfo}) {
    if (_cfg != null) return;
    try {
      if (!_isText(cfg.app) || !_isText(cfg.key, 512) || !_isText(cfg.apiUrl, 2048)) {
        if (cfg.debug || _debugBuildOn) _warn('Apparent: start needs app, key and apiUrl');
        return;
      }
      _begin(cfg._sane(), appState, deviceInfo);
    } catch (e) {
      _log('could not start', e);
    }
  }

  void _begin(ApparentConfig cfg, ApparentAppState appState, Future<ApparentDevice>? deviceInfo) {
    _cfg = cfg;
    if (cfg.userId != null && cfg.userId!.isNotEmpty) _userId = _cut(cfg.userId!, 128);
    _appState = appState;
    // Consent first: nothing is kept until the saved state says they agreed, or optIn() is called.
    if (cfg.optOutByDefault && _consentBeforeLoad == null) {
      _optedOut = true;
      _waitingForConsent = true;
    }
    _loading = (() async {
      if (deviceInfo != null) {
        try {
          device = await deviceInfo;
        } catch (_) {/* keep what we have */}
      }
      await _restore(cfg);
    })();
    _interval = Timer.periodic(cfg.flushInterval, (_) => flush());
  }

  Future<void> _restore(ApparentConfig cfg) async {
    try {
      await _read(cfg);
    } catch (e) {
      _log('could not read saved events', e);
    } finally {
      // Whatever happened, the SDK works from here (a half-read state must never stop saving for good).
      if (!_loaded) {
        if (_anon.isEmpty) _anon = _uid();
        for (final e in _queue) {
          e.early = null;
          if (e.a.isEmpty) e.a = _anon;
        }
        _loaded = true;
      }
    }
    await _persistNow();
  }

  Future<void> _read(ApparentConfig cfg) async {
    _Saved? saved;
    try {
      final raw = await _storage.read(_storageKey);
      if (raw != null) saved = _Saved.from(jsonDecode(raw));
    } catch (_) {/* unreadable: start fresh */}
    final fresh = saved?.anon == null;
    var anon = saved?.anon ?? '';
    var anonSource = saved?.anonSource ?? 'own';
    // Only on first launch: following an id that changes at login would split one person into two ids.
    if (fresh && cfg.anonymousId != null) {
      try {
        final id = await cfg.anonymousId!();
        if (id != null && id.trim().isNotEmpty) {
          anon = _cut(id, 128);
          anonSource = 'provider';
        }
      } catch (_) {/* make our own */}
    }
    if (anon.isEmpty) {
      anon = _uid();
      anonSource = 'own';
    }
    final savedProps = saved?.props ?? const <String, Object?>{};
    final savedUser = saved?.userId;
    // A logout before the disk was read already started a new person: keep that, not the saved one.
    if (!_resetBeforeLoad) {
      _anon = anon;
      _anonSource = anonSource;
      if (_userId == null && !_identifiedBeforeLoad) _userId = savedUser;
      _props = {...savedProps, ..._props};
    }
    if (_consentBeforeLoad != null) {
      _optedOut = _consentBeforeLoad == 'out';
    } else {
      _consented = saved?.consent == true;
      _optedOut = (saved?.optedOut ?? false) || (cfg.optOutByDefault && !_consented);
    }
    _waitingForConsent = false;
    final now = _now();
    final old = [for (final e in saved?.queue ?? const <_Queued>[]) if (now - e.t < _maxEventAgeMs) e];
    // Events tracked while we were reading the disk belong after the saved ones, with the saved id, user and
    // properties (they weren't known yet), unless a logout came first.
    final dropped = <_Queued>{};
    for (final e in _queue) {
      if (e.a.isEmpty) e.a = anon;
      final early = e.early;
      if (early == null) continue;
      e.early = null;
      if (early.afterReset) continue;
      // The saved properties weren't known when it was tracked: clean it again, and let beforeSend see it again.
      final kept = _hook(early.name, _cleanProps({...savedProps, ...early.props}), e.t);
      if (kept == null) {
        dropped.add(e);
        continue;
      }
      e.n = kept.n;
      e.p = kept.p;
      if (e.u == null && !early.afterIdentify) e.u = savedUser;
    }
    _queue = [...old, ..._queue.where((e) => !dropped.contains(e))];
    _loaded = true;

    final current = device.app != null ? '${device.app} (${device.build ?? '?'})' : null;
    final savedApp = saved?.app;
    if (fresh) {
      _enqueue('first_open');
    } else if (savedApp != null && current != null && savedApp != current) {
      _enqueue('app_updated', {'from_version': savedApp, 'to_version': current});
    }
    _appVersion = current;
    if (_appState == ApparentAppState.active) {
      _open(true);
    } else {
      _pendingOpen = true;
    }
    if (_optedOut) _queue = [];
  }

  void _open(bool cold) {
    _pendingOpen = false;
    _activeSince = _now();
    _backgroundAt = null;
    _errorsThisVisit = 0;
    _enqueue('app_open', {'cold': cold});
  }

  /// The app came to the front, went to the background, or is half hidden. `Apparent.start` wires this to Flutter.
  void setAppState(ApparentAppState next) => _guard(() {
        final prev = _appState;
        _appState = next;
        if (!_loaded || _cfg == null) return; // _restore() looks at the latest state when it finishes
        if (next == ApparentAppState.active) {
          if (_pendingOpen) {
            _open(true);
          } else if (_backgroundAt != null) {
            final away = _now() - _backgroundAt!;
            if (away > _cfg!.sessionTimeout.inMilliseconds) {
              _sessionId = _uid();
              _open(false);
            } else {
              _activeSince = _now();
              _backgroundAt = null;
            }
          }
          if (_retryReason == _Kind.network) _retryWait = 0; // the network may be back
          flush();
        } else if (next == ApparentAppState.background) {
          if (prev != ApparentAppState.background && _activeSince != null) {
            _enqueue('app_background', {'seconds': max(0, ((_now() - _activeSince!) / 1000).round())});
            _activeSince = null;
            _backgroundAt = _now();
          }
          _persistNow();
          flush();
        }
      });

  void _enqueue(String name, [Map<String, Object?>? props]) {
    final cfg = _cfg;
    if (cfg == null) return;
    if (cfg.disabled) {
      if (cfg.debug) _print('$name ${props ?? ''}');
      return;
    }
    // With optOutByDefault, events before the saved state is read wait in memory: they go if consent was saved.
    if (_optedOut && !(_waitingForConsent && !_loaded)) return;
    final merged = {..._props, ..._readProps(props)};
    final t = _now();
    final kept = _hook(_cut(name, 80), _cleanProps(merged), t);
    if (kept == null) return;
    final e = _Queued(kept.n, t, _sessionId, _uid(), kept.p, _anon, _userId);
    if (!_loaded) e.early = _Early(_cut(name, 80), merged, _resetBeforeLoad, _identifiedBeforeLoad);
    _queue.add(e);
    final over = _queue.length + _inflight.length - cfg.maxQueue;
    if (over > 0) _queue.removeRange(0, min(over, _queue.length));
    if (cfg.debug) _print('${e.n} ${e.p ?? ''}');
    _schedulePersist();
    if (_queue.length >= cfg.flushAt) flush();
  }

  /// The app's beforeSend: the event it returns (cleaned again), or null when it drops it. A hook that throws keeps it.
  ({String n, Map<String, Object?>? p})? _hook(String n, Map<String, Object?>? p, int t) {
    final fn = _cfg?.beforeSend;
    if (fn == null) return (n: n, p: p);
    ApparentEvent? out;
    try {
      out = fn(ApparentEvent(name: n, props: p == null ? null : {...p}, time: DateTime.fromMillisecondsSinceEpoch(t)));
    } catch (e) {
      if (!_warnedHook) {
        _warnedHook = true;
        _log('beforeSend threw; the event is sent as it was', e);
      }
      return (n: n, p: p);
    }
    if (out == null || out.name.trim().isEmpty) return null;
    return (n: _cut(out.name, 80), p: _cleanProps(out.props));
  }

  /// Record something a person did. Names: lowercase_snake. Props: flat values (string, number, bool, null).
  /// A blank name is ignored; a longer one than 80 characters is cut.
  void track(String name, [Map<String, Object?>? props]) {
    if (_cfg == null || name.trim().isEmpty) return;
    _guard(() => _enqueue(name, props));
  }

  /// Record that a screen was shown. Repeats of the current screen are ignored.
  void screen(String name, [Map<String, Object?>? props]) {
    if (_cfg == null || name.trim().isEmpty || name == _screenName) return;
    _guard(() {
      final from = _screenName;
      _screenName = name;
      _enqueue('screen_view', {..._readProps(props), 'screen': name, 'from': from ?? _absent});
    });
  }

  /// The screen shown last (what `screen` saw), or null.
  String? get currentScreen => _screenName;

  /// Report an error you caught yourself. Flutter and Dart errors are caught automatically.
  /// [how]: "reported" (you), "uncaught" (Flutter/Dart's error handlers), "crash" (with [fatal]).
  void captureError(Object error, {StackTrace? stack, bool fatal = false, String? how, Map<String, Object?>? extra}) {
    if (_cfg == null || _errorsThisVisit >= _maxErrorsPerVisit) return;
    _errorsThisVisit++;
    _guard(() {
      // Like a JavaScript Error, always with a stack: the one it was thrown with, else where it was reported.
      final f = errorFields(error, stack ?? (error is Error ? error.stackTrace : null) ?? StackTrace.current);
      _enqueue('error', {
        ..._readProps(extra),
        'message': f['message'],
        'type': f['type'],
        'fatal': fatal,
        'how': how ?? 'reported',
        'stack': f['stack'] ?? _absent,
        'screen': _screenName ?? _absent,
      });
    });
  }

  /// A link opened the app: sends `deep_link_opened` with the link (secrets in it redacted, see [cleanDeepLink]) and
  /// its `utm_` fields. Pass a [Uri] or a [String]; call it once per link (the launch link and each later one).
  void trackDeepLink(Object? link) {
    final cfg = _cfg;
    if (cfg == null || !cfg.trackDeepLinks) return;
    _guard(() {
      final url = link is Uri ? link.toString() : (link is String ? link : null);
      if (url == null || url.trim().isEmpty) return;
      _enqueue('deep_link_opened', cleanDeepLink(url));
    });
  }

  /// Someone tapped a notification: sends `push_opened` with only the `campaign` (the data's `campaign`, else
  /// `utm_campaign`) and `title` (the data's `title`) the app put in the notification's [data]. Never the text people
  /// saw. Pass the message id as [id] and a tap reported twice (the launch message and the listener) counts once.
  void trackPushOpened(Map<String, Object?>? data, {String? id}) {
    final cfg = _cfg;
    if (cfg == null || !cfg.trackPushOpens) return;
    _guard(() {
      if (id != null && id.isNotEmpty) {
        if (_recentPushes.contains(id)) return;
        _recentPushes.add(id);
        if (_recentPushes.length > 20) _recentPushes.removeAt(0);
      }
      final d = _readProps(data);
      String? pick(Object? v) => v is String && v.isNotEmpty ? v : null;
      final campaign = pick(d['campaign']) ?? pick(d['utm_campaign']);
      final title = pick(d['title']);
      _enqueue('push_opened', {'campaign': campaign ?? _absent, 'title': title ?? _absent});
    });
  }

  /// Who is using the app, once they log in. `null` when they log out (or call [logout]). Saved at once.
  void identify(String? userId) => _guard(() {
        _userId = userId == null || userId.isEmpty ? null : _cut(userId, 128);
        if (!_loaded) _identifiedBeforeLoad = true;
        // Saved now, not in a quarter second: an app killed right after a sign-in or logout must wake up as that person.
        _persistNow();
      });

  /// Properties added to every event from now on, e.g. {'language': 'de', 'plan': 'pro'}. `null` removes one.
  void setProperties(Map<String, Object?>? props) => _guard(() {
        for (final entry in _entriesOf(props)) {
          final key = _cut(entry.key, 64);
          final value = _cleanValue(entry.value);
          if (value == null || identical(value, _absent)) {
            _props.remove(key);
          } else {
            _props[key] = value;
          }
        }
        _schedulePersist();
      });

  void unsetProperty(String key) => _guard(() {
        _props.remove(key);
        _schedulePersist();
      });

  /// Someone logged out: forget who they were and start a new anonymous id (and visit). Saved at once.
  void logout() => _guard(() {
        if (!_loaded) _resetBeforeLoad = true;
        _anon = _uid();
        _anonSource = 'reset';
        _userId = null;
        _props = {};
        _sessionId = _uid();
        _screenName = null;
        _persistNow();
      });

  /// Same as [logout] (the Expo SDK's name).
  void reset() => logout();

  /// Stop collecting (for example when someone declines analytics). Remembered across launches.
  void optOut() => _guard(() {
        _optedOut = true;
        _consented = false;
        _waitingForConsent = false;
        if (!_loaded) _consentBeforeLoad = 'out';
        _queue = [];
        _persistNow();
      });

  /// Start collecting again, or for the first time with `optOutByDefault`. Remembered across launches.
  void optIn() => _guard(() {
        _optedOut = false;
        _consented = true;
        _waitingForConsent = false;
        if (!_loaded) _consentBeforeLoad = 'in';
        _persistNow();
      });

  bool get isOptedOut => _optedOut;

  /// This install's id. Final once [ready] has finished.
  String get anonymousId => _anon;

  String? get userId => _userId;

  /// Finishes once saved events and ids are loaded.
  Future<void> ready() => _loading;

  /// Store this person's Apparent id on their RevenueCat customer, so purchases join to what they did:
  /// `Apparent.linkRevenueCat((attrs) => Purchases.setAttributes(attrs))`.
  Future<void> linkRevenueCat(FutureOr<void> Function(Map<String, String> attributes) setAttributes) async {
    await _loading;
    try {
      await setAttributes({'apparent_id': _anon});
    } catch (e) {
      _log('could not link RevenueCat', e);
    }
  }

  /// Send what is queued now. Safe to call any time: only one send runs at once.
  Future<void> flush() {
    if (_cfg == null) return Future.value();
    final running = _sending;
    if (running != null) {
      _sendAgain = true;
      return running;
    }
    final f = _drain().catchError((Object e) => _log('send failed', e)).whenComplete(() {
      _sending = null;
      if (_sendAgain) {
        _sendAgain = false;
        if (_queue.isNotEmpty && _due()) flush();
      }
    });
    _sending = f;
    return f;
  }

  /// True once the retry wait is over. It is over when either clock says so: the one that only goes forward (so the
  /// phone's clock going back never stretches it) or the phone's clock (the other may stop while the phone sleeps). A
  /// clock that jumps forward just ends the wait sooner.
  bool _due() {
    if (_retryWait <= 0) return true;
    if (_elapsed() - _retryFromElapsed >= _retryWait || _now() - _retryFromNow >= _retryWait) {
      _retryWait = 0;
      return true;
    }
    return false;
  }

  Future<void> _drain() async {
    await _loading;
    final cfg = _cfg!;
    if (cfg.disabled || _optedOut) {
      _queue = [];
      return;
    }
    final cutoff = _now() - _maxEventAgeMs;
    _queue.removeWhere((e) => e.t < cutoff);
    var sent = false;
    while (_queue.isNotEmpty && _due()) {
      final take = min(_batchSize, _queue.length);
      final batch = _queue.sublist(0, take);
      _queue.removeRange(0, take);
      _inflight = batch;
      // Nothing may be in flight without being on disk: a crash mid-send must not lose it.
      if (_persistTimer != null) await _persistNow();
      final result = await _send(batch);
      _inflight = [];
      sent = true;
      if (result.kind == _Kind.ok || result.kind == _Kind.drop) {
        if (result.kind == _Kind.drop) {
          _log('server refused ${batch.length} events (${result.status})');
          // Retrying never fixes a wrong key, so the batch is dropped; say so once, loudly, while developing.
          if (result.status == 401 && !_warnedKey && (cfg.debug || _debugBuildOn)) {
            _warnedKey = true;
            _warn(wrongKeyWarning);
          }
        }
        _failures = 0;
        _retryWait = 0;
        _retryReason = null;
        if (result.kind == _Kind.ok && _batchSize < _maxBatch) _batchSize = min(_maxBatch, _batchSize * 2);
        continue;
      }
      if (result.kind == _Kind.tooLarge) {
        if (batch.length == 1) {
          _log('dropped one event the server says is too large');
          continue;
        }
        _batchSize = max(1, batch.length ~/ 2);
        _queue.insertAll(0, batch);
        continue;
      }
      _queue.insertAll(0, batch);
      _failures++;
      _retryReason = result.kind;
      // The server's Retry-After exactly (already 1 s .. 1 h), never earlier; our own backoff with ±20 % jitter.
      final backoff = min(5 * 60000, cfg.retryBase.inMilliseconds * pow(2, min(_failures - 1, 20)).toInt());
      _retryWait = result.retryAfterMs ?? (backoff * (0.8 + _rand() * 0.4)).round();
      _retryFromElapsed = _elapsed();
      _retryFromNow = _now();
      _log('send failed (${result.status ?? result.kind.name}), next try in ${(_retryWait / 1000).round()} s');
      break;
    }
    if (sent) await _persistNow();
  }

  /// The JSON body for one batch: the Expo SDK's wire format (server/ingest.ts reads it).
  Map<String, Object?> encodeBatch(List<Map<String, Object?>> events, {int? sentAt}) {
    final cfg = _cfg!;
    final first = events.first;
    final d = {...device.toJson(), 'anon': (first['a'] as String?)?.isNotEmpty == true ? first['a'] : _anon, 'user': first['u']};
    final e = [
      for (final ev in events)
        {
          for (final entry in ev.entries)
            if (entry.key != 'a' && entry.key != 'u') entry.key: entry.value,
          if ((ev['a'] as String?)?.isNotEmpty == true && ev['a'] != d['anon']) 'a': ev['a'],
          if (ev['u'] != d['user']) 'u': ev['u'],
        }
    ];
    return {'a': cfg.app, 'k': cfg.key, 'v': sdkVersion, 'sa': sentAt ?? _now(), 'd': d, 'e': e};
  }

  Future<_SendResult> _send(List<_Queued> batch) async {
    final cfg = _cfg!;
    try {
      final body = jsonEncode(encodeBatch([for (final q in batch) q.toJson()]));
      final url = Uri.parse('${cfg.apiUrl.replaceFirst(RegExp(r'/$'), '')}/i');
      final res = await _http
          .post(url, headers: {'content-type': 'application/json'}, body: body)
          .timeout(cfg.requestTimeout);
      final s = res.statusCode;
      if (s >= 200 && s < 300) return const _SendResult(_Kind.ok);
      if (s == 413) return const _SendResult(_Kind.tooLarge, status: 413);
      if (s == 408 || s == 429 || s >= 500) {
        return _SendResult(_Kind.server, status: s, retryAfterMs: retryAfterMs(res.headers['retry-after'], now: _now));
      }
      return _SendResult(_Kind.drop, status: s);
    } catch (_) {
      return const _SendResult(_Kind.network);
    }
  }

  void _schedulePersist() {
    if (_persistTimer != null || !_loaded) return;
    _persistTimer = Timer(const Duration(milliseconds: 250), () {
      _persistTimer = null;
      _persistNow();
    });
  }

  /// Save ids, properties and the queue now (it normally happens within a quarter second).
  Future<void> persistNow() => _persistNow();

  Future<void> _persistNow() async {
    _persistTimer?.cancel();
    _persistTimer = null;
    final cfg = _cfg;
    if (cfg == null || cfg.disabled || !_loaded) return;
    try {
      final all = [..._inflight, ..._queue];
      final state = {
        'v': 2,
        'anon': _anon,
        'anonSource': _anonSource,
        'userId': _userId,
        'props': _props,
        'optedOut': _optedOut,
        if (_consented) 'consent': true,
        'app': _appVersion,
        'queue': [for (final q in all.length > cfg.maxQueue ? all.sublist(all.length - cfg.maxQueue) : all) q.toJson()],
      };
      // A disk that never answers must not hold sending or ready(): stop waiting after a second (the write goes on).
      await _storage.write(_storageKey, jsonEncode(state)).timeout(_writeWait);
    } on TimeoutException {
      _log('saving is slow; not waiting for it');
    } catch (e) {
      _log('could not save events', e);
    }
  }

  /// Stop timers, after saving what is queued. For tests and hot restart.
  Future<void> shutdown() async {
    _interval?.cancel();
    _interval = null;
    await _loading;
    await _persistNow();
  }

  /// Public methods never throw into the app (SPEC 6).
  void _guard(void Function() fn) {
    try {
      fn();
    } catch (e) {
      _log('ignored a call that failed', e);
    }
  }

  void _log(String message, [Object? detail]) {
    if (_cfg?.debug == true) _print('$message ${detail ?? ''}');
  }

  // ignore: avoid_print
  void _print(String s) => print('[apparent] $s');
}
