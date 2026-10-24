// The same promises as sdk/expo/test/sdk.test.ts, for the Dart client.
import 'package:apparent/apparent.dart';
import 'package:apparent/src/client.dart' show retryAfterMs;
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  group('ids', () {
    test('the install id is made once and kept across launches', () async {
      final server = FakeServer();
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      final id = a.anonymousId;
      expect(id, matches(RegExp(r'^[0-9a-f]{32}$')));
      await a.shutdown();

      final b = makeClient(server, storage)..start(testConfig());
      await b.ready();
      expect(b.anonymousId, id);
      await b.flush();
      // first_open only on the first launch; app_open on both
      expect(server.names.where((n) => n == 'first_open'), hasLength(1));
      expect(server.names.where((n) => n == 'app_open'), hasLength(2));
      await b.shutdown();
    });

    test('a provided id is used on the first launch only', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig(anonymousId: () async => 'rc-123'));
      await a.ready();
      expect(a.anonymousId, 'rc-123');
      expect(saved(storage)['anonSource'], 'provider');
      await a.shutdown();
      // After login the provider's id may change (Mixpanel's distinct_id does); we keep the first one.
      final b = makeClient(FakeServer(), storage)..start(testConfig(anonymousId: () async => 'user-9'));
      await b.ready();
      expect(b.anonymousId, 'rc-123');
      await b.shutdown();
    });

    test('a failing id provider falls back to our own id', () async {
      final a = makeClient(FakeServer(), MemoryStorage())..start(testConfig(anonymousId: () async => throw StateError('x')));
      await a.ready();
      expect(a.anonymousId, matches(RegExp(r'^[0-9a-f]{32}$')));
      await a.shutdown();
    });

    test('identify keeps the install id; logout makes a new one and forgets user and properties', () async {
      final server = FakeServer();
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      final first = a.anonymousId;
      a.setProperties({'plan': 'pro'});
      a.identify('user-1');
      a.track('signed_in');
      expect(a.anonymousId, first);
      await a.persistNow();
      expect(saved(storage)['userId'], 'user-1');

      a.logout();
      a.track('signed_out');
      await a.flush();
      expect(a.anonymousId, isNot(first));
      expect(a.userId, isNull);
      final byName = {for (final e in server.accepted) e['n']: e};
      expect(byName['signed_in']!['anon'], first);
      expect(byName['signed_in']!['user'], 'user-1');
      expect(byName['signed_in']!['p'], {'plan': 'pro'});
      expect(byName['signed_out']!['anon'], a.anonymousId);
      expect(byName['signed_out']!['user'], isNull);
      expect(byName['signed_out']!.containsKey('p'), isFalse);
      expect(byName['signed_out']!['s'], isNot(byName['signed_in']!['s']));
      expect(saved(storage)['anonSource'], 'reset');
      await a.shutdown();
    });

    test('the user id and properties are remembered across launches', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.identify('user-7');
      a.setProperties({'language': 'de'});
      await a.shutdown();
      final server = FakeServer();
      final b = makeClient(server, storage)..start(testConfig());
      await b.ready();
      b.track('hello');
      await b.flush();
      final hello = server.accepted.firstWhere((e) => e['n'] == 'hello');
      expect(hello['user'], 'user-7');
      expect(hello['p'], {'language': 'de'});
      await b.shutdown();
    });

    test('userId in the config wins over the saved one', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.identify('old');
      await a.shutdown();
      final b = makeClient(FakeServer(), storage)..start(testConfig(userId: 'new'));
      await b.ready();
      expect(b.userId, 'new');
      await b.shutdown();
    });

    test('events tracked before the saved state is read get the real id, after the saved events', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.track('saved_one');
      await a.shutdown();
      final server = FakeServer();
      final b = makeClient(server, storage)..start(testConfig());
      b.track('early'); // before ready()
      await b.ready();
      await b.flush();
      final names = server.names;
      expect(names.indexOf('saved_one'), lessThan(names.indexOf('early')));
      expect(server.accepted.firstWhere((e) => e['n'] == 'early')['anon'], b.anonymousId);
      await b.shutdown();
    });
  });

  group('queue', () {
    test('every event is saved within a quarter second, before any send', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      a.track('tap');
      await sleep(300);
      expect([for (final e in saved(storage)['queue'] as List) e['n']], contains('tap'));
      await a.shutdown();
    });

    test('offline: events wait, then go once the network is back', () async {
      final server = FakeServer()..mode = 'offline';
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      a.track('one');
      await a.flush();
      expect(server.seen, isEmpty);
      expect((saved(storage)['queue'] as List), hasLength(3)); // first_open, app_open, one
      server.mode = 'ok';
      await sleep(60); // retryBase 30 ms (±20 %)
      await a.flush();
      expect(server.accepted.map((e) => e['n']), ['first_open', 'app_open', 'one']);
      expect((saved(storage)['queue'] as List), isEmpty);
      await a.shutdown();
    });

    test('the waiting queue survives a restart (a crash mid-send loses nothing)', () async {
      final server = FakeServer()..mode = 'hang';
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig(requestTimeout: const Duration(seconds: 5)));
      await a.ready();
      a.track('in_flight');
      a.flush(); // hangs: the app is "killed" while the batch is in flight
      await sleep(50);
      expect([for (final e in saved(storage)['queue'] as List) e['n']], contains('in_flight'));

      final server2 = FakeServer();
      final b = makeClient(server2, storage)..start(testConfig());
      await b.ready();
      await b.flush();
      expect(server2.names, containsAllInOrder(['first_open', 'app_open', 'in_flight', 'app_open']));
      await b.shutdown();
    });

    test('one send at a time', () async {
      final server = FakeServer()..latencyMs = 20;
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      for (var i = 0; i < 5; i++) {
        a.track('e$i');
        a.flush();
      }
      await sleep(10);
      await a.flush();
      await sleep(100);
      expect(server.maxInFlight, 1);
      expect(server.seen, hasLength(7));
      await a.shutdown();
    });

    test('a batch is sent at flushAt events', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig(flushAt: 5));
      await a.ready();
      for (var i = 0; i < 3; i++) {
        a.track('e$i');
      }
      await sleep(30);
      expect(server.seen, hasLength(5));
      await a.shutdown();
    });

    test('a slow server times out and is tried again', () async {
      final server = FakeServer()..mode = 'hang';
      final a = makeClient(server, MemoryStorage())..start(testConfig(requestTimeout: const Duration(milliseconds: 50)));
      await a.ready();
      await a.flush();
      expect(server.seen, isEmpty);
      server.mode = 'ok';
      await sleep(60);
      await a.flush();
      expect(server.seen, hasLength(2));
      await a.shutdown();
    });

    test('retries wait longer each time', () async {
      final server = FakeServer()..mode = '500';
      final a = makeClient(server, MemoryStorage())..start(testConfig(retryBase: const Duration(milliseconds: 40)));
      await a.ready();
      await a.flush(); // fail 1 → wait ~40 ms
      await a.flush(); // too early: no request
      expect(server.requests, hasLength(1));
      await sleep(60);
      await a.flush(); // fail 2 → wait ~80 ms
      expect(server.requests, hasLength(2));
      await sleep(60);
      await a.flush();
      expect(server.requests, hasLength(2));
      await sleep(60);
      await a.flush();
      expect(server.requests, hasLength(3));
      await a.shutdown();
    });

    test('Retry-After is honoured', () async {
      final server = FakeServer()
        ..mode = '429'
        ..retryAfter = '2';
      final a = makeClient(server, MemoryStorage())..start(testConfig(retryBase: const Duration(milliseconds: 1)));
      await a.ready();
      await a.flush();
      server.mode = 'ok';
      await sleep(100);
      await a.flush();
      expect(server.requests, hasLength(1)); // still waiting the 2 s (±20 %)
      await a.shutdown();
    });

    test('413 splits the batch until it fits', () async {
      final server = FakeServer()..maxEvents = 3;
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      for (var i = 0; i < 8; i++) {
        a.track('e$i');
      }
      await a.flush();
      expect(server.seen, hasLength(10));
      expect(server.accepted.map((e) => e['n']).skip(2), [for (var i = 0; i < 8; i++) 'e$i']);
      await a.shutdown();
    });

    test('refused batches (400, 401) are dropped, not retried forever', () async {
      final server = FakeServer()..mode = '400';
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      await a.flush();
      server.mode = 'ok';
      await a.flush();
      expect(server.requests, hasLength(1));
      expect(saved(storage)['queue'], isEmpty);
      await a.shutdown();
    });

    test('at most maxQueue events wait; the oldest go first', () async {
      final server = FakeServer()..mode = 'offline';
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig(maxQueue: 5));
      await a.ready();
      for (var i = 0; i < 10; i++) {
        a.track('e$i');
      }
      await a.persistNow();
      expect([for (final e in saved(storage)['queue'] as List) e['n']], ['e5', 'e6', 'e7', 'e8', 'e9']);
      await a.shutdown();
    });

    test('events older than a week are dropped', () async {
      final storage = MemoryStorage();
      final old = DateTime.now().millisecondsSinceEpoch - 8 * 24 * 3600 * 1000;
      storage.values['apparent:v2'] =
          '{"v":2,"anon":"abc","anonSource":"own","userId":null,"props":{},"optedOut":false,"app":"1.0.0 (1)",'
          '"queue":[{"n":"ancient","t":$old,"s":"s","i":"x1","a":"abc","u":null},'
          '{"n":"recent","t":${old + 2 * 24 * 3600 * 1000},"s":"s","i":"x2","a":"abc","u":null}]}';
      final server = FakeServer();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      await a.flush();
      expect(server.names, ['recent', 'app_open']);
      await a.shutdown();
    });

    test('the batch carries the phone clock as sa', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      await a.flush();
      expect(server.requests.single['sa'], closeTo(DateTime.now().millisecondsSinceEpoch, 5000));
      await a.shutdown();
    });
  });

  group('lifecycle', () {
    test('app_updated when the version changed since the last launch', () async {
      final storage = MemoryStorage();
      final a = makeClient(FakeServer(), storage)..start(testConfig());
      await a.ready();
      await a.shutdown();
      final server = FakeServer();
      final b = makeClient(server, storage, device: const ApparentDevice(platform: 'ios', app: '1.1.0', build: '7'))
        ..start(testConfig());
      await b.ready();
      await b.flush();
      final updated = server.accepted.firstWhere((e) => e['n'] == 'app_updated');
      expect(updated['p'], {'from_version': '1.0.0 (1)', 'to_version': '1.1.0 (7)'});
      await b.shutdown();
    });

    test('a launch in the background is not a visit until the app comes to the front', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig(), appState: ApparentAppState.background);
      await a.ready();
      await a.flush();
      expect(server.names, ['first_open']);
      a.setAppState(ApparentAppState.active);
      await a.flush();
      expect(server.names, ['first_open', 'app_open']);
      expect(server.accepted.last['p'], {'cold': true});
      await a.shutdown();
    });

    test('background: app_background with seconds, saved and sent right away', () async {
      final server = FakeServer();
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      a.track('tap');
      a.setAppState(ApparentAppState.inactive); // the app switcher: nothing yet
      a.setAppState(ApparentAppState.background);
      await sleep(30);
      expect(server.names, ['first_open', 'app_open', 'tap', 'app_background']);
      expect(server.accepted.last['p'], {'seconds': 0});
      await a.shutdown();
    });

    test('a short trip to the background keeps the visit; a long one starts a new one', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig(sessionTimeout: const Duration(milliseconds: 50)));
      await a.ready();
      a.setAppState(ApparentAppState.background);
      a.setAppState(ApparentAppState.active);
      a.track('same_visit');
      a.setAppState(ApparentAppState.background);
      await sleep(80);
      a.setAppState(ApparentAppState.active);
      a.track('new_visit');
      await a.flush();
      await sleep(20);
      final byName = <String, Map<String, dynamic>>{for (final e in server.accepted) e['n'] as String: e};
      expect(server.names.where((n) => n == 'app_open'), hasLength(2));
      final opens = server.accepted.where((e) => e['n'] == 'app_open').toList();
      expect(opens.last['p'], {'cold': false});
      expect(byName['same_visit']!['s'], opens.first['s']);
      expect(byName['new_visit']!['s'], isNot(opens.first['s']));
      await a.shutdown();
    });
  });

  group('screens and properties', () {
    test('screen_view with from; repeats ignored', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      a.screen('home');
      a.screen('home');
      a.screen('paywall', {'source': 'banner'});
      await a.flush();
      final views = server.accepted.where((e) => e['n'] == 'screen_view').map((e) => e['p']).toList();
      expect(views, [
        {'screen': 'home'},
        {'source': 'banner', 'screen': 'paywall', 'from': 'home'},
      ]);
      await a.shutdown();
    });

    test('values are cut and cleaned like the Expo SDK', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      a.track('x' * 100, {
        'long': 'y' * 600,
        'list': [1, 2],
        'map': {'a': 1},
        'nan': double.nan,
        'k' * 70: 1,
        for (var i = 0; i < 50; i++) 'p$i': i,
      });
      await a.flush();
      final e = server.accepted.last;
      final p = e['p'] as Map;
      expect((e['n'] as String).length, 80);
      expect((p['long'] as String).length, 500);
      expect(p['list'], '[1,2]');
      expect(p['map'], '{"a":1}');
      expect(p['nan'], isNull);
      expect(p.containsKey('k' * 64), isTrue);
      expect(p.length, 40);
      await a.shutdown();
    });
  });

  group('errors', () {
    test('named like the Expo SDK', () {
      expect(errorFields('boom', null), {'message': 'boom', 'type': 'Error'});
      expect(errorFields(Exception('bad thing'), null)['message'], 'bad thing');
      expect(errorFields(Exception('bad thing'), null)['type'], 'Exception');
      expect(errorFields(StateError('no'), null), {'message': 'Bad state: no', 'type': 'StateError'});
      final f = errorFields(const FormatException('nope'), StackTrace.current);
      expect(f['type'], 'FormatException');
      expect((f['stack'] as String).split('\n').length, lessThanOrEqualTo(8));
    });

    test('captured errors carry fatal, how and the screen; at most 20 per visit', () async {
      final server = FakeServer();
      final a = makeClient(server, MemoryStorage())..start(testConfig());
      await a.ready();
      a.screen('checkout');
      a.captureError(StateError('x'), stack: StackTrace.current, how: 'uncaught');
      for (var i = 0; i < 30; i++) {
        a.captureError('again');
      }
      await a.flush();
      final errors = server.accepted.where((e) => e['n'] == 'error').toList();
      expect(errors, hasLength(20));
      final p = errors.first['p'] as Map;
      expect(p['how'], 'uncaught');
      expect(p['fatal'], false);
      expect(p['screen'], 'checkout');
      expect(p['type'], 'StateError');
      expect(p['stack'], isA<String>());
      await a.shutdown();
    });
  });

  group('consent', () {
    test('opt-out sends and saves nothing, and is remembered', () async {
      final server = FakeServer();
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig());
      await a.ready();
      a.optOut();
      a.track('hidden');
      await a.flush();
      expect(server.requests, isEmpty);
      await a.shutdown();
      final b = makeClient(server, storage)..start(testConfig());
      await b.ready();
      expect(b.isOptedOut, isTrue);
      b.track('still_hidden');
      await b.flush();
      expect(server.requests, isEmpty);
      b.optIn();
      b.track('visible');
      await b.flush();
      expect(server.names, ['visible']);
      await b.shutdown();
    });

    test('disabled: nothing stored or sent', () async {
      final server = FakeServer();
      final storage = MemoryStorage();
      final a = makeClient(server, storage)..start(testConfig(disabled: true));
      await a.ready();
      a.track('dev');
      await a.flush();
      await a.shutdown();
      expect(server.requests, isEmpty);
      expect(storage.values, isEmpty);
    });
  });

  test('linkRevenueCat sets apparent_id to the install id', () async {
    final a = makeClient(FakeServer(), MemoryStorage())..start(testConfig());
    Map<String, String>? got;
    await a.linkRevenueCat((attrs) async => got = attrs);
    expect(got, {'apparent_id': a.anonymousId});
    // A RevenueCat failure never reaches the app.
    await a.linkRevenueCat((_) => throw StateError('offline'));
    await a.shutdown();
  });

  test('retryAfterMs reads seconds and dates, kept between 1 s and 1 h', () {
    expect(retryAfterMs('5'), 5000);
    expect(retryAfterMs('0'), 1000);
    expect(retryAfterMs('99999'), 3600000);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT'), 1000);
    expect(retryAfterMs('nonsense'), isNull);
    expect(retryAfterMs(null), isNull);
  });
}
