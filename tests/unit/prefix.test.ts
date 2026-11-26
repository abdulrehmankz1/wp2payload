import { describe, expect, it } from 'vitest'
import { splitTable } from '../../src/extractors/sql/index.js'
import { pickWpConfig, wpConfigPrefix, wpConfigRank } from '../../src/extractors/sql/prefix.js'

// wp-config.php comes from an untrusted backup (doc 12.7): it is tokenized as text, never run, and
// only `$table_prefix = '<letters, digits, _>';` is ever taken from it.

const php = (body: string) => `<?php\n${body}\n`

describe('wpConfigPrefix', () => {
  it('reads the assignment WordPress writes, single or plain double quotes', () => {
    expect(wpConfigPrefix(php("$table_prefix = 'wp_';"))).toEqual({ status: 'found', prefix: 'wp_' })
    expect(wpConfigPrefix(php('$table_prefix  =  "Abc_9";'))).toEqual({ status: 'found', prefix: 'Abc_9' })
    expect(wpConfigPrefix(php("$table_prefix = 'x_'; $table_prefix = 'x_';"))).toEqual({ status: 'found', prefix: 'x_' })
  })

  it('skips comments, strings that look like code, and text outside <?php', () => {
    const src = [
      "$table_prefix = 'html_';",
      '<?php',
      "// $table_prefix = 'line_';",
      "# $table_prefix = 'hash_';",
      "/* $table_prefix = 'block_'; */",
      "define('AUTH_KEY', 'salt /* with comment marks');",
      "define('SECURE_AUTH_KEY', 'and */ $table_prefix = \\'str_\\'; here');",
      "$table_prefix = 'real_';",
      "if ($table_prefix == 'x') { echo $table_prefix; }",
    ].join('\n')
    expect(wpConfigPrefix(src)).toEqual({ status: 'found', prefix: 'real_' })
  })

  it('says none when the variable is never assigned', () => {
    expect(wpConfigPrefix(php("define('DB_NAME', 'wp');"))).toEqual({ status: 'none' })
    expect(wpConfigPrefix('')).toEqual({ status: 'none' })
  })

  it('rejects hostile or computed values instead of guessing', () => {
    const hostile = [
      "$table_prefix = ''; system('x'); //';",
      "$table_prefix = 'wp_'; system('x'); //';".replace("'wp_'", "'wp_\\''"),
      "$table_prefix = 'wp_'.system('id');",
      "$table_prefix = getenv('PREFIX');",
      '$table_prefix = "wp_$suffix";',
      '$table_prefix = "wp_\\x41";',
      "$table_prefix .= 'x_';",
      "$table_prefix = 'a_'; $table_prefix = 'b_';",
      "$table_prefix = 'wp-';",
      `$table_prefix = '${'a'.repeat(65)}';`,
      "$table_prefix = <<<EOT\nwp_\nEOT;",
    ]
    for (const body of hostile) expect(wpConfigPrefix(php(body)), body).toMatchObject({ status: 'invalid' })
  })

  it('never quotes the value in its reason', () => {
    const r = wpConfigPrefix(php("$table_prefix = '\u001b[31mevil; rm -rf';"))
    expect(r.status).toBe('invalid')
    expect(JSON.stringify(r)).not.toMatch(/evil|rm -rf|\\u001b/)
  })

  it('does not run anything: a payload in the file stays text', () => {
    let ran = false
    ;(globalThis as { __wp2pRan?: () => void }).__wp2pRan = () => (ran = true)
    wpConfigPrefix(php("$table_prefix = 'wp_'; __wp2pRan(); eval('__wp2pRan()');"))
    expect(ran).toBe(false)
  })
})

describe('wp-config.php in an archive', () => {
  it('ranks the shallowest wp-config.php first, then Duplicator copies, never wp-content', () => {
    expect(wpConfigRank('wp-config.php')).toBeLessThan(wpConfigRank('dup-installer/dup-wp-config-arc__x.txt')!)
    expect(wpConfigRank('wp-content/plugins/a/wp-config.php')).toBeUndefined()
    expect(wpConfigRank('wp-config-sample.php')).toBeUndefined()
    expect(pickWpConfig(['public_html/wp-config.php', 'public_html/old/wp-config.php', 'dup-installer/dup-wp-config-arc__1.txt'])).toBe('public_html/wp-config.php')
    expect(pickWpConfig(['a/wp-config.php', 'b/wp-config.php'])).toBeUndefined()
    expect(pickWpConfig(['readme.txt'])).toBeUndefined()
  })
})

describe('splitTable', () => {
  it('splits WordPress tables by their known names, with valid prefixes only', () => {
    expect(splitTable('wp_posts')).toEqual({ prefix: 'wp_', table: 'posts' })
    expect(splitTable('wp_2_postmeta')).toEqual({ prefix: 'wp_2_', table: 'postmeta' })
    expect(splitTable('abc_term_taxonomy')).toEqual({ prefix: 'abc_', table: 'term_taxonomy' })
    expect(splitTable('posts')).toBeUndefined()
    expect(splitTable('wp_usermeta')).toBeUndefined()
    expect(splitTable('db.wp_posts')).toBeUndefined()
  })
})
