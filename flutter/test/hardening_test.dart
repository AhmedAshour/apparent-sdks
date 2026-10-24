// The edge cases the big SDKs test in their own suites (PostHog, Amplitude, Segment, Mixpanel, RudderStack), as in
// sdk/expo/test/hardening.test.ts. Only the public API, so the same file runs against older versions of the client.
import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:apparent/apparent.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// A storage that misbehaves in one way.
class BrokenStorage implements ApparentStorage {
  BrokenStorage({this.readThrows = false, this.readRejects = false, this.writeThrows = false, this.writeRejects = false, this.writeHangs = false});
  final bool readThrows, readRejects, writeThrows, writeRejects, writeHangs;

  @override
  Future<String?> read(String key) {
    if (readThrows) throw StateError('read');
    if (readRejects) return Future.error(StateError('read'));
    return Future.value(null);
  }

  @override
  Future<void> write(String key, String value) {
    if (writeThrows) throw StateError('write');
    if (writeRejects) return Future.error(StateError('disk full'));
    if (writeHangs) return Completer<void>().future;
    return Future.value();
  }
}

/// A properties map that throws when it is read (like a JavaScript Proxy or getter).
class ThrowingMap extends MapBase<String, Object?> {
  @override
  Object? operator [](Object? key) => throw StateError('no');
  @override
  void operator []=(String key, Object? value) => throw StateError('no');
  @override
  void clear() {}
  @override
  Iterable<String> get keys => throw StateError('no');
  @override
  Object? remove(Object? key) => null;
}

class BadToString {
  @override
  String toString() => throw StateError('no text');
}

class BadToJson {
  Object toJson() => throw StateError('no json');
  @override
  String toString() => 'bad-json';
}

bool flat(Object? v) => v == null || v is String || v is num || v is bool;

List<Map<String, dynamic>> byName(FakeServer s, String n) => [for (final e in s.accepted) if (e['n'] == n) e];

/// Sends once the retry wait is over: flushes every 20 ms until the server sees a new request, and says when.
Future<int> msUntilNextTry(ApparentClient c, FakeServer s, {int maxMs = 4000}) async {
  final before = s.requests.length;
  final watch = Stopwatch()..start();
  while (s.requests.length == before && watch.elapsedMilliseconds < maxMs) {
    await c.flush();
    if (s.requests.length > before) break;
    await sleep(20);
  }
  return watch.elapsedMilliseconds;
}

void main() {
  group('saved right away', () {
    // Saved now, not with the 250 ms debounce: an app killed right after a sign-in or logout must wake up as that person.
    test('a sign-in is on disk right away, so a kill just after it keeps the user', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.identify('u1');
      await sleep(10);
      expect(saved(storage)['userId'], 'u1');
      await a.shutdown();
    });

    test('identify(null) as a logout is on disk right away too', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig(userId: 'old'));
      await a.ready();
      await a.persistNow();
      a.identify(null);
      await sleep(10);
      expect(saved(storage)['userId'], isNull);
      await a.shutdown();
    });

    test('a logout is on disk right away, so a kill just after it never brings the old user back', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.identify('u1');
      a.setProperties({'plan': 'pro'});
      await a.persistNow();
      final oldAnon = a.anonymousId;
      a.logout();
      await sleep(10);
      expect(saved(storage)['userId'], isNull);
      expect(saved(storage)['anon'], isNot(oldAnon));
      expect(saved(storage)['props'], isEmpty);
      await a.shutdown();
    });

    test('opting out and back in is on disk right away', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.optOut();
      await sleep(10);
      expect(saved(storage)['optedOut'], isTrue);
      a.optIn();
      await sleep(10);
      expect(saved(storage)['optedOut'], isFalse);
      await a.shutdown();
    });
  });

  group('broken saved state', () {
    final now = DateTime.now().millisecondsSinceEpoch;
    final cases = <String, String>{
      'not JSON': '{not json',
      'a number': '5',
      'null': 'null',
      'an array': '[]',
      'fields of the wrong type': jsonEncode(
          {'v': 2, 'anon': 123, 'anonSource': 7, 'userId': 5, 'props': 'str', 'optedOut': 'false', 'queue': 'x', 'app': 7}),
      'a queue with junk in it': jsonEncode({
        'v': 2,
        'anon': 'kept-anon',
        'userId': null,
        'props': {
          'plan': 'pro',
          'bad': {'nested': 1}
        },
        'optedOut': false,
        'app': null,
        'queue': [
          null,
          5,
          'x',
          {'n': 7},
          {'n': 'saved_event', 't': now - 1000, 's': 's1', 'i': 'saved-id-1', 'a': 'kept-anon', 'u': null},
          {'n': 'no_ids', 't': now - 1000},
          {'n': 'bad_time', 't': 'yesterday', 's': 's1', 'i': 'saved-id-2'},
        ],
      }),
    };
    cases.forEach((what, raw) {
      test('saved state that is $what starts cleanly and keeps working', () async {
        final server = FakeServer();
        final storage = MemoryStorage()..values['apparent:v2'] = raw;
        final c = makeClient(server, storage)..start(testConfig());
        await c.ready();
        c.track('after_corrupt', {'ok': true});
        await c.flush();
        final e = byName(server, 'after_corrupt').single;
        expect(e['anon'], isA<String>());
        expect((e['anon'] as String).isNotEmpty, isTrue);
        expect(e['user'] == null || e['user'] is String, isTrue);
        expect(c.isOptedOut, isFalse, reason: 'a saved "false" string is not an opt-out');
        for (final sent in server.seen.values) {
          expect(sent['n'], isA<String>());
          expect(sent['i'], isA<String>());
          expect((sent['s'] as String).isNotEmpty, isTrue, reason: '${sent['n']} has a session');
          final p = sent['p'] as Map?;
          if (p != null) expect(p.values.every(flat), isTrue, reason: '${sent['n']} has flat props: $p');
        }
        await c.persistNow();
        expect(saved(storage)['v'], 2, reason: 'the state on disk is valid again');
        expect(saved(storage)['queue'], isA<List>());
        expect((saved(storage)['props'] as Map).values.every(flat), isTrue, reason: 'saved properties are flat again');
        if (what == 'a queue with junk in it') {
          expect(byName(server, 'saved_event'), hasLength(1), reason: 'the good saved event still went out');
          expect(byName(server, 'no_ids'), isEmpty);
          expect(byName(server, 'bad_time'), isEmpty);
          expect(e['anon'], 'kept-anon', reason: 'the good saved id is kept');
          expect(e['p'], {'plan': 'pro', 'bad': '{"nested":1}', 'ok': true});
        }
        await c.shutdown();
      });
    });
  });

  group('storage that fails', () {
    final broken = <String, BrokenStorage Function()>{
      'throws on read': () => BrokenStorage(readThrows: true),
      'rejects on read': () => BrokenStorage(readRejects: true),
      'throws on write': () => BrokenStorage(writeThrows: true),
      'rejects on write': () => BrokenStorage(writeRejects: true),
      'never finishes a write': () => BrokenStorage(writeHangs: true),
    };
    broken.forEach((what, make) {
      test('storage that $what: the SDK keeps working in memory and never throws', () async {
        final server = FakeServer();
        final c = ApparentClient(storage: make(), httpClient: server.client, device: fixtureDevice)..start(testConfig());
        final ready = await Future.any([c.ready().then((_) => true), sleep(1500).then((_) => false)]);
        expect(ready, isTrue, reason: 'ready() finishes');
        c.track('still_works');
        c.identify('u1');
        c.setProperties({'plan': 'pro'});
        c.track('still_works_2');
        await Future.any([c.flush(), sleep(3000)]);
        c.logout();
        c.optOut();
        c.optIn();
        c.track('still_works_3');
        await Future.any([c.flush(), sleep(3000)]);
        for (final n in ['still_works', 'still_works_2', 'still_works_3']) {
          expect(byName(server, n), hasLength(1), reason: '$n arrived');
        }
      });
    });
  });

  test('Retry-After is waited in full, never sooner (no jitter on the server\'s wait)', () async {
    // Four clients at once: with ±20 % jitter on the server's wait, at least one would come back early.
    Future<int> one() async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(testConfig());
      await c.ready();
      await c.flush();
      server
        ..mode = '429'
        ..retryAfter = '1';
      c.track('x');
      await c.flush();
      server.mode = 'ok';
      final ms = await msUntilNextTry(c, server);
      await c.shutdown();
      return ms;
    }

    final waits = await Future.wait([one(), one(), one(), one()]);
    for (final ms in waits) {
      expect(ms, greaterThanOrEqualTo(980), reason: 'came back after $ms ms, the server asked for 1000');
      expect(ms, lessThan(1400));
    }
  });

  group('properties that aren\'t plain values', () {
    test('dates, functions, NaN, big ints, objects that can\'t be text, deep nesting and too many keys never throw',
        () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(testConfig());
      await c.ready();
      Object deep = 1;
      for (var i = 0; i < 5000; i++) {
        deep = [deep];
      }
      final cyclic = <Object?>[];
      cyclic.add(cyclic);
      c.track('weird', {
        'date': DateTime.utc(2026, 10, 24, 10),
        'fn': () => 1,
        'nan': double.nan,
        'inf': double.infinity,
        'big': BigInt.parse('123456789012345678901234567890'),
        'bad_text': BadToString(),
        'bad_json': BadToJson(),
        'deep': deep,
        'cyclic': cyclic,
        'list': [1, 'a'],
      });
      c.track('many', {for (var i = 0; i < 60; i++) 'k$i': i});
      await c.flush();
      final p = byName(server, 'weird').single['p'] as Map;
      expect(p['date'], '2026-10-24T10:00:00.000Z');
      expect(p.containsKey('fn'), isFalse);
      expect(p['nan'], isNull);
      expect(p['inf'], isNull);
      expect(p['big'], '123456789012345678901234567890');
      expect(p.containsKey('bad_text'), isTrue);
      expect(p['bad_text'], isNull);
      expect(p['bad_json'], 'bad-json');
      expect(p['list'], '[1,"a"]');
      expect(p.values.every(flat), isTrue);
      expect((byName(server, 'many').single['p'] as Map), hasLength(40));
      await c.shutdown();
    });

    test('a properties map that throws when read never throws into the app', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(testConfig());
      await c.ready();
      c.track('a', ThrowingMap());
      c.screen('home', ThrowingMap());
      c.setProperties(ThrowingMap());
      c.captureError(StateError('x'), extra: ThrowingMap());
      c.captureError(BadToString());
      c.track('after');
      await c.flush();
      expect(server.names, containsAll(['a', 'screen_view', 'error', 'after']));
      await c.shutdown();
    });
  });

  test('blank names are ignored; long names are cut to 80; emoji and spaces are kept', () async {
    final server = FakeServer();
    final c = makeClient(server, MemoryStorage())..start(testConfig());
    await c.ready();
    c.track('');
    c.track('   ');
    c.screen('  ');
    c.track('x' * 200);
    c.track('Tap 🎉 now');
    await c.flush();
    expect(server.names.where((n) => n.trim().isEmpty), isEmpty);
    expect(server.names, isNot(contains('screen_view')));
    expect(server.names, containsAll(['x' * 80, 'Tap 🎉 now']));
    await c.shutdown();
  });

  test('a start without an app or key is ignored, so a later good start still works', () async {
    final server = FakeServer();
    final c = makeClient(server, MemoryStorage());
    c.start(const ApparentConfig(app: '', key: 'k', apiUrl: 'http://fake/'));
    c.start(const ApparentConfig(app: 'demo', key: '  ', apiUrl: 'http://fake/'));
    c.start(testConfig());
    await c.ready();
    c.track('works');
    await c.flush();
    expect(byName(server, 'works'), hasLength(1));
    expect(server.requests.every((r) => r['a'] == 'demo' && r['k'] == 'test-key'), isTrue);
    await c.shutdown();
  });

  test('silly numbers in the config never throw or stall', () async {
    final server = FakeServer();
    final c = makeClient(server, MemoryStorage());
    c.start(const ApparentConfig(
      app: 'demo',
      key: 'test-key',
      apiUrl: 'http://fake/',
      maxQueue: -5,
      flushAt: 0,
      flushInterval: Duration(hours: 1),
      requestTimeout: Duration.zero,
      retryBase: Duration(milliseconds: -10),
    ));
    final ready = await Future.any([c.ready().then((_) => true), sleep(1500).then((_) => false)]);
    expect(ready, isTrue);
    c.track('works');
    await c.flush();
    expect(byName(server, 'works'), hasLength(1));
    await c.shutdown();
  });
}
