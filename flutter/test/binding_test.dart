// Flutter wiring: the navigator observer, app lifecycle, Flutter/Dart error handlers, the file storage.
import 'dart:io';
import 'dart:ui';

import 'package:apparent/apparent.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeServer server;
  late MemoryStorage storage;

  setUp(() async {
    server = FakeServer();
    storage = MemoryStorage();
    await Apparent.startWith(makeClient(server, storage), testConfig());
  });

  tearDown(() => Apparent.stop());

  Future<List<Map<String, dynamic>>> sent(WidgetTester tester) async {
    await tester.runAsync(() => Apparent.flush());
    return server.accepted;
  }

  testWidgets('ApparentNavigatorObserver records page routes by name, not dialogs', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: nav,
      navigatorObservers: [ApparentNavigatorObserver()],
      routes: {
        '/': (_) => const Text('home'),
        '/settings/account': (_) => const Text('account'),
        '/paywall': (_) => const Text('paywall'),
      },
    ));
    nav.currentState!.pushNamed('/settings/account');
    await tester.pumpAndSettle();
    showDialog<void>(context: nav.currentContext!, builder: (_) => const Text('dialog'));
    await tester.pumpAndSettle();
    nav.currentState!.pop(); // the dialog
    await tester.pumpAndSettle();
    nav.currentState!.pushReplacementNamed('/paywall');
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();

    final screens = [for (final e in await sent(tester)) if (e['n'] == 'screen_view') (e['p'] as Map)['screen']];
    expect(screens, ['home', 'settings/account', 'paywall', 'home']);
  });

  testWidgets('a custom screenName can name routes or skip them', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: nav,
      navigatorObservers: [ApparentNavigatorObserver(screenName: (r) => r.settings.name == '/' ? 'start' : null)],
      routes: {'/': (_) => const Text('home'), '/x': (_) => const Text('x')},
    ));
    nav.currentState!.pushNamed('/x');
    await tester.pumpAndSettle();
    final screens = [for (final e in await sent(tester)) if (e['n'] == 'screen_view') (e['p'] as Map)['screen']];
    expect(screens, ['start']);
  });

  test('going to the background sends app_background; coming back keeps the visit', () async {
    // A plain test (real timers): the lifecycle comes from Flutter's binding, as on a phone.
    final binding = TestWidgetsFlutterBinding.instance;
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await sleep(30);
    expect(server.names, contains('app_background'));
    binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await Apparent.flush();
    final names = server.names;
    expect(names.where((n) => n == 'app_background'), hasLength(1));
    expect(names.where((n) => n == 'app_open'), hasLength(1));
  });

  test('Flutter errors and uncaught Dart errors become error events, saved at once; earlier handlers still run', () async {
    // flutter_test swaps FlutterError.onError around each testWidgets; here (a plain test) Apparent's is in place.
    await Apparent.stop();
    final seenByApp = <Object>[];
    final flutterBefore = FlutterError.onError;
    final dispatcherBefore = PlatformDispatcher.instance.onError;
    FlutterError.onError = (d) => seenByApp.add(d.exception);
    PlatformDispatcher.instance.onError = (e, s) {
      seenByApp.add(e);
      return true;
    };
    try {
      await Apparent.startWith(makeClient(server, storage), ApparentConfig(app: 'demo', key: 'test-key', apiUrl: 'http://fake'));
      Apparent.screen('cart');
      FlutterError.reportError(FlutterErrorDetails(exception: StateError('layout broke'), stack: StackTrace.current));
      final handled = PlatformDispatcher.instance.onError!(const FormatException('bad json'), StackTrace.current);
      expect(handled, isTrue);
      await sleep(20);
      final queued = [for (final e in saved(storage)['queue'] as List) if (e['n'] == 'error') e['p']];
      expect(queued, hasLength(2));
      expect(queued.first, containsPair('type', 'StateError'));
      expect(queued.first, containsPair('how', 'uncaught'));
      expect(queued.first, containsPair('fatal', false));
      expect(queued.first, containsPair('screen', 'cart'));
      expect(queued.last, containsPair('type', 'FormatException'));
      expect(queued.last, containsPair('message', 'FormatException: bad json'));
      expect(seenByApp, hasLength(2));
    } finally {
      FlutterError.onError = flutterBefore;
      PlatformDispatcher.instance.onError = dispatcherBefore;
    }
  });

  test('FileStorage writes whole files and reads them back', () async {
    final dir = await Directory.systemTemp.createTemp('apparent_test');
    final s = FileStorage(() async => Directory('${dir.path}/apparent'));
    expect(await s.read('apparent:v2'), isNull);
    await Future.wait([for (var i = 0; i < 20; i++) s.write('apparent:v2', '{"n":$i}')]);
    expect(await s.read('apparent:v2'), '{"n":19}');
    expect(Directory('${dir.path}/apparent').listSync().map((f) => f.path.split('/').last), ['apparent_v2.json']);
    await dir.delete(recursive: true);
  });

  test('defaultScreenName follows the Expo router names', () {
    Route<void> page(String? name) => MaterialPageRoute(builder: (_) => const SizedBox(), settings: RouteSettings(name: name));
    expect(defaultScreenName(page('/')), 'home');
    expect(defaultScreenName(page('/practice/recht')), 'practice/recht');
    expect(defaultScreenName(page('/search?q=x')), 'search');
    expect(defaultScreenName(page(null)), isNull);
    expect(defaultScreenName(RawDialogRoute<void>(pageBuilder: (a, b, c) => const SizedBox())), isNull);
  });
}
