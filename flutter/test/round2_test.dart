// Round 2 of the spec (sdk/SPEC.md): events in the first milliseconds after start, a wrong key, the simulator flag,
// and batch size.
import 'dart:convert';

import 'package:apparent/apparent.dart';
import 'package:apparent/src/client.dart' show wrongKeyWarning;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

MemoryStorage savedState() => MemoryStorage()
  ..values['apparent:v2'] = jsonEncode({
    'v': 2, 'anon': 'saved-anon', 'anonSource': 'own', 'userId': 'u1', 'props': {'plan': 'free'},
    'optedOut': false, 'app': '1.0.0 (1)', 'queue': [],
  });

Map<String, dynamic> event(FakeServer s, String name) => s.accepted.firstWhere((e) => e['n'] == name);

Future<void> sendAll(ApparentClient c) async {
  await c.ready();
  for (var i = 0; i < 20; i++) {
    await c.flush();
  }
}

void main() {
  group('events in the first milliseconds after start', () {
    test('get the saved user and properties', () async {
      final server = FakeServer();
      final c = makeClient(server, savedState())..start(testConfig());
      c.track('early', {'n': 1});
      await sendAll(c);
      final e = event(server, 'early');
      expect(e['anon'], 'saved-anon');
      expect(e['user'], 'u1');
      expect(e['p'], {'plan': 'free', 'n': 1});
      await c.shutdown();
    });

    test('a logout right after start is not undone by the saved state', () async {
      final server = FakeServer();
      final storage = savedState();
      final c = makeClient(server, storage)..start(testConfig());
      c.track('before');
      c.logout();
      c.track('after');
      await sendAll(c);
      expect(event(server, 'before')['anon'], 'saved-anon');
      expect(event(server, 'before')['user'], 'u1');
      final after = event(server, 'after');
      expect(after['anon'], isNot('saved-anon'));
      expect(after['user'], isNull);
      expect((after['p'] as Map?)?['plan'], isNull);
      expect(saved(storage)['anon'], after['anon']);
      expect(saved(storage)['userId'], isNull);
      expect(saved(storage)['props'], isEmpty);
      await c.shutdown();
      final next = makeClient(server, storage)..start(testConfig());
      next.track('next_launch');
      await sendAll(next);
      expect(event(server, 'next_launch')['anon'], after['anon']);
      expect(event(server, 'next_launch')['user'], isNull);
      await next.shutdown();
    });

    test('a sign-in right after start wins over the saved user', () async {
      final server = FakeServer();
      final c = makeClient(server, savedState())..start(testConfig());
      c.track('before');
      c.identify('u2');
      c.track('after');
      await sendAll(c);
      expect(event(server, 'before')['user'], 'u1');
      expect(event(server, 'after')['user'], 'u2');
      expect(event(server, 'app_open')['user'], 'u2');
      await c.shutdown();
    });
  });

  group('a wrong app id or key', () {
    ApparentClient client(List<String> warnings, {required bool debugBuild, List<int>? sent}) => ApparentClient(
          storage: MemoryStorage(),
          httpClient: MockClient((req) async {
            sent?.add(1);
            return http.Response('{"error":"unauthorized"}', 401);
          }),
          device: fixtureDevice,
          debugBuild: debugBuild,
          warn: warnings.add,
        );

    test('warns once in a debug build, and drops the batches', () async {
      final warnings = <String>[];
      final sent = <int>[];
      final c = client(warnings, debugBuild: true, sent: sent)..start(testConfig());
      await sendAll(c);
      c.track('again');
      await sendAll(c);
      expect(sent, hasLength(2));
      expect(warnings, [wrongKeyWarning]);
      await c.shutdown();
    });

    test('quiet in a release build', () async {
      final warnings = <String>[];
      final c = client(warnings, debugBuild: false)..start(testConfig());
      await sendAll(c);
      expect(warnings, isEmpty);
      await c.shutdown();
    });
  });

  test('the simulator flag is sent only when true', () async {
    final server = FakeServer();
    const sim = ApparentDevice(platform: 'ios', os: '18.0', app: '1.0.0', model: 'arm64', simulator: true);
    final a = makeClient(server, MemoryStorage(), device: sim)..start(testConfig());
    await sendAll(a);
    expect((server.requests.last['d'] as Map)['simulator'], true);
    await a.shutdown();
    final b = makeClient(server, MemoryStorage())..start(testConfig());
    await sendAll(b);
    expect((server.requests.last['d'] as Map).containsKey('simulator'), isFalse);
    await b.shutdown();
  });

  test('a long queue goes out in batches of at most 100, nothing lost', () async {
    final server = FakeServer();
    final c = makeClient(server, MemoryStorage())..start(testConfig(flushAt: 10000));
    await c.ready();
    for (var n = 0; n < 250; n++) {
      c.track('burst', {'n': n});
    }
    await sendAll(c);
    expect(server.requests.every((r) => (r['e'] as List).length <= 100), isTrue);
    final burst = server.accepted.where((e) => e['n'] == 'burst').map((e) => (e['p'] as Map)['n']).toSet();
    expect(burst, hasLength(250));
    await c.shutdown();
  });
}
