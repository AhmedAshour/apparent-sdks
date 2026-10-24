import 'dart:async';
import 'dart:convert';

import 'package:apparent/apparent.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Future<void> sleep(int ms) => Future<void>.delayed(Duration(milliseconds: ms));

/// The device the Expo fixture was made with (sdk/expo/test/mocks).
const fixtureDevice = ApparentDevice(
  platform: 'ios',
  os: '18.0',
  app: '1.0.0',
  build: '1',
  model: 'iPhone15,2',
  locale: 'en-DE',
  region: 'DE',
  tz: 'Europe/Berlin',
);

/// A fake Apparent intake that records every request and can misbehave on demand.
class FakeServer {
  final requests = <Map<String, dynamic>>[];
  final urls = <String>[];
  final headers = <Map<String, String>>[];

  /// Events the server accepted, by insert id, with the anon/user the server would store (server/ingest.ts).
  final seen = <String, Map<String, dynamic>>{};
  int inFlight = 0;
  int maxInFlight = 0;

  /// ok | hang | 500 | 429 | offline | 400
  String mode = 'ok';
  int latencyMs = 2;
  String retryAfter = '1';
  int maxEvents = 1 << 30;

  late final http.Client client = MockClient((req) async {
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    requests.add(body);
    urls.add(req.url.toString());
    headers.add(req.headers);
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      if (mode == 'hang') await Completer<void>().future.timeout(const Duration(seconds: 30));
      await sleep(latencyMs);
      if (mode == 'offline') throw http.ClientException('Network request failed');
      if (mode == '500') return http.Response('', 500);
      if (mode == '429') return http.Response('', 429, headers: {'retry-after': retryAfter});
      if (mode == '400') return http.Response('', 400);
      final events = (body['e'] as List).cast<Map<String, dynamic>>();
      if (events.length > maxEvents) return http.Response('', 413);
      final d = body['d'] as Map<String, dynamic>;
      for (final e in events) {
        seen[e['i'] as String] = {
          ...e,
          'anon': e['a'] ?? d['anon'],
          'user': e.containsKey('u') ? e['u'] : d['user'],
        };
      }
      return http.Response('{"ok":true}', 200);
    } finally {
      inFlight--;
    }
  });

  List<String> get names => [for (final r in requests) for (final e in r['e'] as List) e['n'] as String];
  List<Map<String, dynamic>> get accepted => seen.values.toList()..sort((a, b) => (a['t'] as int).compareTo(b['t'] as int));
}

ApparentClient makeClient(FakeServer server, MemoryStorage storage, {ApparentDevice device = fixtureDevice}) =>
    ApparentClient(storage: storage, httpClient: server.client, device: device);

ApparentConfig testConfig({
  Future<String?> Function()? anonymousId,
  String? userId,
  int flushAt = 1000,
  int maxQueue = 1000,
  Duration requestTimeout = const Duration(seconds: 2),
  Duration retryBase = const Duration(milliseconds: 30),
  Duration sessionTimeout = const Duration(minutes: 30),
  bool disabled = false,
}) =>
    ApparentConfig(
      app: 'demo',
      key: 'test-key',
      apiUrl: 'http://fake/',
      anonymousId: anonymousId,
      userId: userId,
      flushAt: flushAt,
      maxQueue: maxQueue,
      requestTimeout: requestTimeout,
      retryBase: retryBase,
      sessionTimeout: sessionTimeout,
      disabled: disabled,
      flushInterval: const Duration(hours: 1),
    );

Map<String, dynamic> saved(MemoryStorage s) => jsonDecode(s.values['apparent:v2'] ?? '{}') as Map<String, dynamic>;

/// The same normalisation as tool/expo_fixture.mjs: random ids, times and stacks become labels.
List<Map<String, dynamic>> normalize(List<Map<String, dynamic>> bodies) {
  final labels = <String, String>{};
  String? label(String kind, Object? v) {
    if (v == null) return null;
    final key = '$kind:$v';
    return labels.putIfAbsent(key, () => '<$kind${labels.keys.where((k) => k.startsWith('$kind:')).length + 1}>');
  }

  return [
    for (final b in bodies)
      {
        ...b,
        'v': '<v>',
        'sa': '<sa>',
        'd': {...b['d'] as Map<String, dynamic>, 'anon': label('anon', (b['d'] as Map)['anon'])},
        'e': [
          for (final e in (b['e'] as List).cast<Map<String, dynamic>>())
            {
              ...e,
              't': '<t>',
              'i': '<id>',
              's': label('session', e['s']),
              if (e.containsKey('a')) 'a': label('anon', e['a']),
              if ((e['p'] as Map?)?.containsKey('stack') == true) 'p': {...e['p'] as Map, 'stack': '<stack>'},
            }
        ],
      }
  ];
}
