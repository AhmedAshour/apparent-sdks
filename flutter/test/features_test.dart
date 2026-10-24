// Clocks, Retry-After, links, notifications, beforeSend and consent, as in sdk/expo/test/features.test.ts and the
// clock and Retry-After parts of sdk/expo/test/hardening.test.ts.
import 'package:apparent/apparent.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

List<Map<String, dynamic>> byName(FakeServer s, String n) => [for (final e in s.accepted) if (e['n'] == n) e];

ApparentConfig cfg({
  ApparentEvent? Function(ApparentEvent event)? beforeSend,
  bool optOutByDefault = false,
  bool trackDeepLinks = true,
  bool trackPushOpens = true,
  Duration retryBase = const Duration(milliseconds: 30),
}) =>
    ApparentConfig(
      app: 'demo',
      key: 'test-key',
      apiUrl: 'http://fake/',
      flushAt: 1000,
      flushInterval: const Duration(hours: 1),
      requestTimeout: const Duration(seconds: 2),
      retryBase: retryBase,
      beforeSend: beforeSend,
      optOutByDefault: optOutByDefault,
      trackDeepLinks: trackDeepLinks,
      trackPushOpens: trackPushOpens,
    );

/// Flushes every 20 ms for [ms].
Future<void> keepFlushing(ApparentClient c, int ms) async {
  final w = Stopwatch()..start();
  while (w.elapsedMilliseconds < ms) {
    await c.flush();
    await sleep(20);
  }
}

void main() {
  group('clocks that jump', () {
    int real() => DateTime.now().millisecondsSinceEpoch;

    test("the phone's clock jumping back a day during a retry wait doesn't strand the queue", () async {
      var offset = 0;
      final server = FakeServer();
      final c = ApparentClient(storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, now: () => real() + offset)
        ..start(cfg());
      await c.ready();
      await c.flush();
      server.mode = '500';
      c.track('waiting');
      await c.flush();
      expect(c.retryWaitMs, greaterThan(0));
      offset = -86400000;
      server.mode = 'ok';
      await keepFlushing(c, 300);
      expect(byName(server, 'waiting'), hasLength(1), reason: 'sent within the normal wait, not a day later');
      await c.shutdown();
    });

    test("the clock jumping back during a Retry-After wait doesn't stretch it past the server's wait", () async {
      var offset = 0;
      final server = FakeServer();
      final c = ApparentClient(storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, now: () => real() + offset)
        ..start(cfg());
      await c.ready();
      await c.flush();
      server
        ..mode = '429'
        ..retryAfter = '1';
      c.track('waiting');
      await c.flush();
      offset = -3600000;
      server.mode = 'ok';
      await keepFlushing(c, 1400);
      expect(byName(server, 'waiting'), hasLength(1));
      await c.shutdown();
    });

    test('the clock jumping forward a day just retries sooner, nothing is dropped', () async {
      var offset = 0;
      final server = FakeServer();
      final c = ApparentClient(storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, now: () => real() + offset)
        ..start(cfg(retryBase: const Duration(seconds: 30)));
      await c.ready();
      await c.flush();
      server.mode = '500';
      c.track('waiting');
      await c.flush();
      offset = 86400000;
      server.mode = 'ok';
      await c.flush();
      expect(byName(server, 'waiting'), hasLength(1));
      await c.shutdown();
    });

    test('a wait still ends when the forward-only clock stops (a phone asleep)', () async {
      final server = FakeServer();
      final c = ApparentClient(
          storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, elapsed: () => 0)
        ..start(cfg());
      await c.ready();
      await c.flush();
      server.mode = '500';
      c.track('waiting');
      await c.flush();
      server.mode = 'ok';
      await keepFlushing(c, 200);
      expect(byName(server, 'waiting'), hasLength(1));
      await c.shutdown();
    });
  });

  group('Retry-After', () {
    const h = 3600000;
    Future<int> waitFor(String header, double random) async {
      final server = FakeServer();
      final c = ApparentClient(storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, random: () => random)
        ..start(cfg());
      await c.ready();
      await c.flush();
      server
        ..mode = '429'
        ..retryAfter = header;
      c.track('x');
      await c.flush();
      final wait = c.retryWaitMs;
      await c.shutdown();
      return wait;
    }

    String httpDate(DateTime d) {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      final u = d.toUtc();
      String two(int n) => n.toString().padLeft(2, '0');
      return '${days[u.weekday - 1]}, ${two(u.day)} ${months[u.month - 1]} ${u.year} ${two(u.hour)}:${two(u.minute)}:${two(u.second)} GMT';
    }

    final now = DateTime.now();
    final cases = <(String, String, int, int)>[
      ('2 seconds is waited in full, never less', '2', 2000, 2000),
      ('more than an hour is cut to an hour', '7200', h, h),
      ('negative becomes 1 s', '-5', 1000, 1000),
      ('zero becomes 1 s', '0', 1000, 1000),
      ('an HTTP date two hours away is cut to an hour', httpDate(now.add(const Duration(hours: 2))), h, h),
      ('an HTTP date in the past becomes 1 s', httpDate(now.subtract(const Duration(hours: 1))), 1000, 1000),
    ];
    for (final (what, header, lo, hi) in cases) {
      for (final r in [0.0, 0.999]) {
        test('$what (jitter ${r == 0 ? 'low' : 'high'})', () async {
          final wait = await waitFor(header, r);
          expect(wait, inInclusiveRange(lo, hi));
        });
      }
    }

    test('a garbage Retry-After falls back to the normal backoff (never stuck)', () async {
      final wait = await waitFor('soon-ish', 0.5);
      expect(wait, inInclusiveRange(1, 999));
    });

    test('our own backoff keeps its ±20 % jitter', () async {
      final server = FakeServer()..mode = '500';
      final lo = ApparentClient(storage: MemoryStorage(), httpClient: server.client, device: fixtureDevice, random: () => 0)
        ..start(cfg(retryBase: const Duration(seconds: 2)));
      await lo.ready();
      await lo.flush();
      expect(lo.retryWaitMs, 1600);
      await lo.shutdown();
    });
  });

  group('deep links', () {
    test('cleanDeepLink redacts secrets, drops user:password@, splits out utm_ and keeps the rest', () {
      final c = cleanDeepLink('myapp://user:pw@open/reset?access_token=abc&id=7&utm_source=news%20letter&utm_medium=email'
          '&utm_campaign=fall+sale#code=123&tab=2');
      expect(c['url'], 'myapp://open/reset?access_token=[redacted]&id=7&utm_source=news%20letter&utm_medium=email'
          '&utm_campaign=fall+sale#code=[redacted]&tab=2');
      expect(c['utm_source'], 'news letter');
      expect(c['utm_medium'], 'email');
      expect(c['utm_campaign'], 'fall sale');
      expect(cleanDeepLink('https://x.app/a?Session_ID=1&SIG=2&apiKey=3&password=4&auth=5')['url'],
          'https://x.app/a?Session_ID=[redacted]&SIG=[redacted]&apiKey=[redacted]&password=[redacted]&auth=[redacted]');
    });

    test('cleanDeepLink: long links are cut, links without a query stay as they are, bad escapes never throw', () {
      expect(cleanDeepLink('myapp://a/${'x' * 800}')['url'], hasLength(500));
      expect(cleanDeepLink('myapp://home'), {'url': 'myapp://home'});
      expect(cleanDeepLink('myapp://a#section'), {'url': 'myapp://a#section'});
      expect(cleanDeepLink('myapp://a?%zz=1&token=%zz')['url'], 'myapp://a?%zz=1&token=[redacted]');
    });

    test('trackDeepLink sends deep_link_opened with its campaign and without secrets; a Uri works too', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(cfg());
      await c.ready();
      c.trackDeepLink('myapp://promo?utm_source=ig&code=SECRET');
      c.trackDeepLink(Uri.parse('https://app.example/p/1?token=t'));
      c.trackDeepLink('');
      c.trackDeepLink(42);
      await c.flush();
      final links = byName(server, 'deep_link_opened');
      expect(links, hasLength(2));
      expect(links[0]['p'], {'url': 'myapp://promo?utm_source=ig&code=[redacted]', 'utm_source': 'ig'});
      expect(links[1]['p'], {'url': 'https://app.example/p/1?token=[redacted]'});
      await c.shutdown();
    });

    test('trackDeepLinks: false sends no deep_link_opened; a normal launch sends none either', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(cfg(trackDeepLinks: false));
      await c.ready();
      await c.flush();
      expect(byName(server, 'deep_link_opened'), isEmpty);
      c.trackDeepLink('myapp://x');
      await c.flush();
      expect(byName(server, 'deep_link_opened'), isEmpty);
      await c.shutdown();
    });
  });

  group('notifications', () {
    test('push_opened: once per tap, campaign and title from the data only, never the text', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(cfg());
      await c.ready();
      c.trackPushOpened({'campaign': 'winback', 'title': 'Come back', 'body': 'Hi Ahmed', 'user_email': 'a@b.c'}, id: 'm1');
      c.trackPushOpened({'campaign': 'winback'}, id: 'm1'); // the launch message and the listener: one tap
      c.trackPushOpened({'utm_campaign': 'oct', 'title': ''}, id: 'm2');
      c.trackPushOpened(null);
      await c.flush();
      final taps = byName(server, 'push_opened');
      expect(taps, hasLength(3));
      expect(taps[0]['p'], {'campaign': 'winback', 'title': 'Come back'});
      expect(taps[1]['p'], {'campaign': 'oct'});
      expect(taps[2].containsKey('p'), isFalse);
      await c.shutdown();
    });

    test('trackPushOpens: false ignores taps', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())..start(cfg(trackPushOpens: false));
      await c.ready();
      c.trackPushOpened({'campaign': 'x'}, id: 'm1');
      await c.flush();
      expect(byName(server, 'push_opened'), isEmpty);
      await c.shutdown();
    });
  });

  group('beforeSend', () {
    test('it can change an event, drop it, and a hook that throws keeps it', () async {
      final server = FakeServer();
      final c = makeClient(server, MemoryStorage())
        ..start(cfg(beforeSend: (e) {
          if (e.name == 'debug_tap') return null;
          if (e.name == 'boom') throw StateError('hook');
          if (e.name == 'signup') {
            e.props?.remove('email');
            e.props?['nested'] = {'a': 1};
            e.name = 'sign_up';
          }
          return e;
        }));
      await c.ready();
      c.track('debug_tap');
      c.track('signup', {'email': 'a@b.c', 'plan': 'pro'});
      c.track('boom', {'x': 1});
      await c.flush();
      expect(server.names, isNot(contains('debug_tap')));
      expect(byName(server, 'sign_up').single['p'], {'plan': 'pro', 'nested': '{"a":1}'});
      expect(byName(server, 'boom').single['p'], {'x': 1});
      expect(server.names, containsAll(['first_open', 'app_open']), reason: 'automatic events go through it too');
      await c.shutdown();
    });

    test('it also sees events tracked before the saved state was read, with the saved properties', () async {
      final storage = MemoryStorage();
      final first = makeClient(FakeServer(), storage)..start(cfg());
      await first.ready();
      first.setProperties({'plan': 'pro'});
      await first.shutdown();

      final seen = <String, Map<String, Object?>?>{};
      final server = FakeServer();
      final c = makeClient(server, storage)
        ..start(cfg(beforeSend: (e) {
          seen[e.name] = e.props == null ? null : {...e.props!};
          return e.name == 'early_drop' ? null : e;
        }));
      c.track('early', {'a': 1});
      c.track('early_drop');
      await c.ready();
      await c.flush();
      expect(seen['early'], {'plan': 'pro', 'a': 1});
      expect(byName(server, 'early').single['p'], {'plan': 'pro', 'a': 1});
      expect(byName(server, 'early_drop'), isEmpty);
      await c.shutdown();
    });
  });

  group('consent first', () {
    test('optOutByDefault: nothing until optIn(), then remembered; optOut() later is remembered too', () async {
      final storage = MemoryStorage();
      final server = FakeServer();
      final a = makeClient(server, storage)..start(cfg(optOutByDefault: true));
      a.track('too_early');
      await a.ready();
      expect(a.isOptedOut, isTrue);
      a.track('before_consent');
      await a.flush();
      expect(server.requests, isEmpty);
      expect(saved(storage)['queue'], isEmpty);
      a.optIn();
      await sleep(10);
      expect(saved(storage)['consent'], isTrue, reason: 'saved right away');
      a.track('after_consent');
      await a.flush();
      expect(server.names, ['after_consent']);
      await a.shutdown();

      final b = makeClient(server, storage)..start(cfg(optOutByDefault: true));
      b.track('early_with_consent');
      await b.ready();
      expect(b.isOptedOut, isFalse, reason: 'consent survives a relaunch');
      await b.flush();
      expect(server.names, containsAll(['early_with_consent', 'app_open']));
      b.optOut();
      await b.shutdown();

      final c = makeClient(server, storage)..start(cfg(optOutByDefault: true));
      await c.ready();
      expect(c.isOptedOut, isTrue);
      expect(saved(storage).containsKey('consent'), isFalse);
      await c.shutdown();
    });

    test('optIn() before the saved state is read wins; apps without optOutByDefault save exactly what they did before',
        () async {
      final storage = MemoryStorage();
      final server = FakeServer();
      final a = makeClient(server, storage)..start(cfg(optOutByDefault: true));
      a.optIn();
      a.track('right_away');
      await a.ready();
      await a.flush();
      expect(server.names, contains('right_away'));
      await a.shutdown();

      final plain = MemoryStorage();
      final b = makeClient(FakeServer(), plain)..start(cfg());
      await b.ready();
      await b.persistNow();
      expect(saved(plain).keys.toSet(), {'v', 'anon', 'anonSource', 'userId', 'props', 'optedOut', 'app', 'queue'});
      await b.shutdown();
    });
  });

  test('every field the SDK saves survives a relaunch (the saved-state check never drops a new one)', () async {
    final storage = MemoryStorage();
    final server = FakeServer()..mode = 'offline';
    final a = makeClient(server, storage)..start(cfg(optOutByDefault: true));
    await a.ready();
    a.optIn();
    a.identify('u1');
    a.setProperties({'plan': 'pro'});
    a.track('queued');
    await a.flush();
    await a.persistNow();
    final before = saved(storage);
    expect(before.keys.toSet(), {'v', 'anon', 'anonSource', 'userId', 'props', 'optedOut', 'consent', 'app', 'queue'});
    await a.shutdown();

    final b = makeClient(server, storage)..start(cfg(optOutByDefault: true));
    await b.ready();
    await b.persistNow();
    final after = saved(storage);
    for (final k in before.keys) {
      if (k == 'queue') continue; // the relaunch adds its own app_open
      expect(after[k], before[k], reason: '$k survives');
    }
    final queued = [for (final e in after['queue'] as List) e as Map];
    for (final e in before['queue'] as List) {
      expect(queued, contains(equals(e)), reason: 'saved event ${(e as Map)['n']} kept as it was');
    }
    await b.shutdown();
  });

  group('Apparent (static)', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    tearDown(Apparent.stop);

    test('a start without a key is ignored, so a later good start still works', () async {
      final server = FakeServer();
      await Apparent.startWith(makeClient(server, MemoryStorage()), const ApparentConfig(app: 'demo', key: ''));
      expect(Apparent.client, isNull);
      final good = makeClient(server, MemoryStorage());
      await Apparent.startWith(good, cfg());
      expect(Apparent.client, same(good));
      Apparent.trackDeepLink('myapp://x?utm_source=a');
      Apparent.trackPushOpened({'campaign': 'c'}, id: '1');
      Apparent.setProperties(null);
      await Apparent.flush();
      expect(server.names, containsAll(['deep_link_opened', 'push_opened']));
    });
  });
}
