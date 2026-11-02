<?php
/**
 * Hacked-site fixture only: an attacker who can write to the database can point an attachment at
 * any URL. Attachments with `_wp2p_url` report that URL as their source (doc 12.3, T9).
 */
add_filter('wp_get_attachment_url', function ($url, $id) {
    $forced = get_post_meta($id, '_wp2p_url', true);
    return is_string($forced) && $forced !== '' ? $forced : $url;
}, 10, 2);
