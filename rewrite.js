var util = require('util');

var esprima = require('esprima');
var falafel = require('falafel');
var escodegen = require('escodegen');
var _ = require('underscore');

function unwrapRewriteNode(node) {
  if (node.type == 'Program' && node.body.length > 0) {
    node = unwrapRewriteNode(node.body[0]);
  } else if (node.type == 'ExpressionStatement') {
    node = unwrapRewriteNode(node.expression);
  }
  return node;
}

function isWildcard(name) {
  return /\b[a-z]\b/g.test(name);
}

function matchNode(wildcards, pattern, node) {
  if (pattern == null && node != null) {
    return false;
  }

  if (pattern != null && node == null) {
    return false;
  }

  if (wildcards != null && pattern.type == 'Identifier' && isWildcard(pattern.name)) {
    if (pattern.name in wildcards) {
      return matchNode(null, wildcards[pattern.name], node);
    }
    wildcards[pattern.name] = node;
    return true;
  }

  if (pattern.type != node.type) {
    return false;
  }

  switch (pattern.type) {
    case 'Program':
    case 'BlockStatement':
      for (var i = 0; i < pattern.body.length; i++) {
        if (!_.any(node.body, function(body) {
          return matchNode(wildcards, pattern.body[i], body);
        })) {
          return false;
        }
      }
      return true;
    case 'Identifier':
      return pattern.name == node.name;
    case 'Property':
      if (pattern.kind != node.kind) {
        return false;
      }
      return matchNode(wildcards, pattern.key, node.key)
          && matchNode(wildcards, pattern.value, node.value);
    case 'MemberExpression':
      if (pattern.computed != node.computed) {
        return false;
      }
      return matchNode(wildcards, pattern.object, node.object)
          && matchNode(wildcards, pattern.property, node.property);
    case 'ArrayExpression':
      for (var i = 0; i < pattern.elements.length; i++) {
        if (!_.any(node.elements, function(element) {
          return matchNode(wildcards, pattern.elements[i], element);
        })) {
          return false;
        }
      }
      return true;
    case 'ObjectExpression':
      for (var i = 0; i < pattern.properties.length; i++) {
        if (!_.any(node.properties, function(property) {
          return matchNode(wildcards, pattern.properties[i], property);
        })) {
          return false;
        }
      }
      return true;
    case 'BinaryExpression':
      if (pattern.operator != node.operator) {
        return false;
      }
      return matchNode(wildcards, pattern.left, node.left)
          && matchNode(wildcards, pattern.right, node.right);
    case 'ForStatement':
      return matchNode(wildcards, pattern.init, node.init)
          && matchNode(wildcards, pattern.test, node.test)
          && matchNode(wildcards, pattern.update, node.update)
          && matchNode(wildcards, pattern.body, node.body);
    case 'VariableDeclaration':
      if (pattern.kind != node.kind) {
        return false;
      }
      for (var i = 0; i < pattern.declarations.length; i++) {
        if (!_.any(node.declarations, function(declaration) {
          return matchNode(wildcards, pattern.declarations[i], declaration);
        })) {
          return false;
        }
      }
      return true;
    case 'FunctionExpression':
      if (pattern.id != node.id) {
        return false;
      }
      if (pattern.rest != node.rest) {
        return false;
      }
      if (pattern.generator != node.generator) {
        return false;
      }
      if (pattern.expression != node.expression) {
        return false;
      }
      if (pattern.params.length != node.params.length) {
        return false;
      }
      for (var i = 0; i < pattern.params.length; i++) {
        if (!matchNode(wildcards, pattern.params[i], node.params[i])) {
          return false;
        }
      }
      if (pattern.defaults.length != node.defaults.length) {
        return false;
      }
      for (var i = 0; i < pattern.defaults.length; i++) {
        if (!matchNode(wildcards, pattern.defaults[i], node.defaults[i])) {
          return false;
        }
      }
      if (!matchNode(wildcards, pattern.body, node.body)) {
        return false;
      }
      return true;
    case 'UpdateExpression':
      if (pattern.operator != node.operator) {
        return false;
      }
      if (pattern.prefix != node.prefix) {
        return false;
      }
      return matchNode(wildcards, pattern.argument, node.argument);
    case 'VariableDeclarator':
      return matchNode(wildcards, pattern.id, node.id)
          && matchNode(wildcards, pattern.init, node.init);
    case 'Literal':
      return pattern.raw == node.raw;
    case 'ExpressionStatement':
      return matchNode(wildcards, pattern.expression, node.expression);
    case 'CallExpression':
      if (!matchNode(wildcards, pattern.callee, node.callee)) {
        return false;
      }
      for (var i = 0; i < pattern.arguments.length; i++) {
        if (!_.any(node.arguments, function(argument) {
          return matchNode(wildcards, pattern.arguments[i], argument);
        })) {
          return false;
        }
      }
      return true;
    case 'ReturnStatement':
      return matchNode(wildcards, pattern.argument, node.argument);
    default:
      console.error(pattern.type, "not yet supported in match", pattern);
      return false;
  }

  return false;
}

// `replaceWildcards` replaces wildcards with matched wildcard values
function replaceWildcards(wildcards, replacement) {
  switch (replacement.type) {
    case 'Identifier':
      if (wildcards != null && isWildcard(replacement.name)) {
        if (replacement.name in wildcards) {
          replacement = wildcards[replacement.name];
        }
      }
      break;
    case 'Program':
      for (var i = 0; i < replacement.body.length; i++) {
        replacement.body[i] = replaceWildcards(wildcards, replacement.body[i]);
      }
      break;
    case 'ArrayExpression':
      for (var i = 0; i < replacement.elements.length; i++) {
        replacement.elements[i] = replaceWildcards(wildcards, replacement.elements[i]);
      }
      break;
    case 'MemberExpression':
      replacement.object = replaceWildcards(wildcards, replacement.object);
      replacement.property = replaceWildcards(wildcards, replacement.property);
      break;
    case 'CallExpression':
      replacement.callee = replaceWildcards(wildcards, replacement.callee);
      for (var i = 0; i < replacement.arguments.length; i++) {
        replacement.arguments[i] = replaceWildcards(wildcards, replacement.arguments[i]);
      }
      break;
    case 'FunctionExpression':
      replacement.body = replaceWildcards(wildcards, replacement.body);
      for (var i = 0; i < replacement.params.length; i++) {
        replacement.params[i] = replaceWildcards(wildcards, replacement.params[i]);
      }
      break;
    case 'Property':
      replacement.key = replaceWildcards(wildcards, replacement.key);
      replacement.value = replaceWildcards(wildcards, replacement.value);
      replacement.kind = replaceWildcards(wildcards, replacement.kind);
      break;
    case 'BinaryExpression':
      replacement.left = replaceWildcards(wildcards, replacement.left);
      replacement.right = replaceWildcards(wildcards, replacement.right);
      break;
    case 'VariableDeclaration':
      for (var i = 0; i < replacement.declarations.length; i++) {
        replacement.declarations[i] = replaceWildcards(wildcards, replacement.declarations[i]);
      }
      break;
    case 'VariableDeclarator':
      replacement.init = replaceWildcards(wildcards, replacement.init);
      break;
    case 'BlockStatement':
      for (var i = 0; i < replacement.body.length; i++) {
        replacement.body[i] = replaceWildcards(wildcards, replacement.body[i]);
      }
      break;
    case 'ReturnStatement':
      replacement.argument = replaceWildcards(wildcards, replacement.argument);
      break;
    case 'ExpressionStatement':
      replacement.expression = replaceWildcards(wildcards, replacement.expression);
      break;
    case 'UpdateExpression':
      replacement.argument = replaceWildcards(wildcards, replacement.argument);
      break;
    case 'ForStatement':
      replacement.init = replaceWildcards(wildcards, replacement.init);
      replacement.test = replaceWildcards(wildcards, replacement.test);
      replacement.update = replaceWildcards(wildcards, replacement.update);
      replacement.body = replaceWildcards(wildcards, replacement.body);
      break;
    case 'ObjectExpression':
      for (var i = 0; i < replacement.properties.length; i++) {
        replacement.properties[i] = replaceWildcards(wildcards, replacement.properties[i]);
      }
      break;
    case 'Literal':
      break; // no-op
    default:
      console.error(replacement.type, "not yet supported in replace", replacement);
      break;
  }

  return replacement;
}

exports.rewriteJavascript = function(js, rewriteRule) {
  var rewriteRuleRe = /\s*->\s*/g;
  if (!rewriteRuleRe.test(rewriteRule)) {
    return js;
  }

  var rewriteRuleParts = rewriteRule.split(rewriteRuleRe);
  if (rewriteRuleParts.length != 2) {
    return js;
  }

  var parseOptions = { raw: true };
  var pattern = unwrapRewriteNode(esprima.parse(rewriteRuleParts[0], parseOptions));
  var replacement = unwrapRewriteNode(esprima.parse(rewriteRuleParts[1], parseOptions));

  return falafel(js, parseOptions, function(node) {
    var wildcards = {};
    if (matchNode(wildcards, pattern, node)) {
      node.update(escodegen.generate(replaceWildcards(wildcards, _.clone(replacement))));
    }
  });
}

exports.findJavascript = function(js, findRule) {
  var pattern = unwrapRewriteNode(esprima.parse(findRule, { raw: true }));

  var matches = [];
  falafel(js, { raw: true, loc: true }, function(node) {
    var wildcards = {};
    if (matchNode(wildcards, pattern, node)) {
      matches.push({ node: node, wildcards: wildcards })
    }
  });
  return matches;
}
