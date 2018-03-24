const JDLParser = require('./parser').JDLParser;
const _ = require('lodash');

module.exports = {
  buildAst
};

const BaseJDLCSTVisitor = new JDLParser().getBaseCstVisitorConstructor();

/**
 * Note that the logic here assumes the input CST is valid.
 * To make this work with partially formed CST created during automatic error recovery
 * would require refactoring for greater robustness.
 * Meaning we can never assume at least one element exists in a ctx child array
 * e.g:
 * 1. ctx.NAME[0].image --> ctx.NAME[0] ? ctx.NAME[0].image : "???"
 */
class JDLAstBuilderVisitor extends BaseJDLCSTVisitor {
  constructor() {
    super();
    this.validateVisitor();
  }

  prog(ctx) {
    const ast = {
      applications: [],
      constants: {},
      entities: [],
      relationships: [],
      enums: [],
      dto: {},
      pagination: {},
      service: {},
      microservice: {},
      searchEngine: {},
      noClient: { list: [], excluded: [] },
      noServer: { list: [], excluded: [] },
      filter: { list: [], excluded: [] },
      angularSuffix: {},
      noFluentMethod: { list: [], excluded: [] },
      clientRootFolder: {}
    };

    if (ctx.constantDeclaration) {
      const constants = ctx.constantDeclaration.map(this.visit, this);
      constants.forEach((currConst) => {
        ast.constants[currConst.name] = currConst.value;
      });
    }

    if (ctx.applicationDeclaration) {
      ast.applications = ctx.applicationDeclaration.map(this.visit, this);
    }

    if (ctx.entityDeclaration) {
      ast.entities = ctx.entityDeclaration.map(this.visit, this);
    }

    if (ctx.relationDeclaration) {
      ast.relationships = _.flatMap(ctx.relationDeclaration, item =>
        this.visit(item)
      );
    }

    if (ctx.enumDeclaration) {
      ast.enums = ctx.enumDeclaration.map(this.visit, this);
    }

    const ctxToAstMapping = {
      dtoDeclaration: 'dto',
      paginationDeclaration: 'pagination',
      serviceDeclaration: 'service',
      microserviceDeclaration: 'microservice',
      searchEngineDeclaration: 'searchEngine',
      angularSuffixDeclaration: 'angularSuffix',
      noFluentMethod: 'noFluentMethod',
      filterDeclaration: 'filter',
      clientRootFolderDeclaration: 'clientRootFolder',
      noClientDeclaration: 'noClient',
      noServerDeclaration: 'noServer',
      filter: 'filter'
    };

    _.forEach(ctxToAstMapping, (astName, ctxName) => {
      if (ctx[ctxName]) {
        const astItems = ctx[ctxName].map(this.visit, this);
        astItems.forEach((astNewItem) => {
          let astResult;
          if (astNewItem.name) {
            if (!ast[astName][astNewItem.name]) {
              astResult = { list: astNewItem.list, excluded: [] };
              ast[astName][astNewItem.name] = astResult;
            } else {
              astResult = ast[astName][astNewItem.name];
            }
          } else {
            astResult = ast[astName];
          }

          // TODO: This merge logic reproduces "addUniqueElements" from the pegjs parser.
          // Not sure this logic is relevant to anything but strings/numbers as it uses strict equality
          astResult.list = _.uniq(astResult.list.concat(astNewItem.list));

          if (astNewItem.excluded) {
            astResult.excluded = _.uniq(
              astResult.excluded.concat(astNewItem.excluded)
            );
          }
        });
      }
    });

    return ast;
  }

  constantDeclaration(ctx) {
    return {
      name: ctx.NAME[0].image,
      value: parseInt(ctx.INTEGER[0].image, 10)
    };
  }

  entityDeclaration(ctx) {
    let comment = null;
    if (ctx.COMMENT) {
      comment = trimComment(ctx.COMMENT[0].image);
    }

    const name = ctx.NAME[0].image;
    let tableName = name;
    if (ctx.entityTableNameDeclaration) {
      tableName = this.visit(ctx.entityTableNameDeclaration);
    }

    let eb = [];
    if (ctx.entityBody) {
      eb = this.visit(ctx.entityBody);
    }

    return {
      name,
      tableName,
      body: eb,
      javadoc: comment
    };
  }

  entityTableNameDeclaration(ctx) {
    return ctx.NAME[0].image;
  }

  entityBody(ctx) {
    return _.map(ctx.fieldDeclaration, element => this.visit(element));
  }

  fieldDeclaration(ctx) {
    // filter actual comment as the comment rule may be empty
    const comment = ctx.COMMENT ? trimComment(ctx.COMMENT[0].image) : null;

    return {
      name: ctx.NAME[0].image,
      // ctx.type is an array with a single item.
      // in that case:
      // this.visit(ctx.type) is equivalent to this.visit(ctx.type[0])
      type: this.visit(ctx.type),
      validations: ctx.validation
        ? _.map(ctx.validation, element => this.visit(element))
        : [],
      javadoc: comment
    };
  }

  type(ctx) {
    return ctx.NAME[0].image;
  }

  validation(ctx) {
    // only one of these alternatives can exist at the same time.
    if (ctx.REQUIRED) {
      return {
        key: 'required',
        value: ''
      };
    } else if (ctx.minMaxValidation) {
      return this.visit(ctx.minMaxValidation);
    }
    return this.visit(ctx.pattern);
  }

  minMaxValidation(ctx) {
    const isIdentifier = ctx.NAME !== undefined;
    const validationAst = {
      key: ctx.MIN_MAX_KEYWORD[0].image,
      value: isIdentifier
        ? ctx.NAME[0].image
        : parseInt(ctx.INTEGER[0].image, 10)
    };

    if (isIdentifier) {
      validationAst.constant = true;
    }
    return validationAst;
  }

  pattern(ctx) {
    const patternImage = ctx.REGEX[0].image;

    return {
      key: 'pattern',
      value: patternImage.substring(1, patternImage.length - 1)
    };
  }

  relationDeclaration(ctx) {
    const cardinality = this.visit(ctx.relationshipType);
    const relBodies = ctx.relationshipBody.map(this.visit, this);

    relBodies.forEach((rb) => {
      rb.cardinality = cardinality;
    });

    return relBodies;
  }

  relationshipType(ctx) {
    if (ctx.ONE_TO_ONE) {
      return 'one-to-one';
    } else if (ctx.ONE_TO_MANY) {
      return 'one-to-many';
    } else if (ctx.MANY_TO_ONE) {
      return 'many-to-one';
    } else if (ctx.MANY_TO_MANY) {
      return 'many-to-many';
    }

    throw new Error('Non exhaustive match');
  }

  relationshipBody(ctx) {
    const from = this.visit(ctx.from);
    const to = this.visit(ctx.to);

    return { from, to };
  }

  relationshipSide(ctx) {
    const jd = this.visit(ctx.comment);
    const name = ctx.NAME[0].image;

    const required = !!ctx.REQUIRED;
    let injectedfield = null;

    if (ctx.InjectedField) {
      injectedfield = ctx.InjectedField[0].image;

      if (ctx.InjectedFieldParam) {
        injectedfield += `(${ctx.InjectedFieldParam[0].image})`;
      }
    }

    const ast = {
      name,
      injectedfield,
      javadoc: jd,
      required
    };

    if (injectedfield === null) {
      delete ast.required;
    }
    return ast;
  }

  enumDeclaration(ctx) {
    const name = ctx.NAME[0].image;
    const values = this.visit(ctx.enumPropList);

    return { name, values };
  }

  enumPropList(ctx) {
    const propNames = ctx.NAME.map(prop => prop.image);
    return propNames;
  }

  dtoDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  entityList(ctx) {
    let el = [];
    if (ctx.NAME) {
      el = ctx.NAME.map(nameToken => nameToken.image);
    }

    if (ctx.ALL || ctx.STAR) {
      el.push('*');
    }

    if (ctx.Method) {
      el.push(ctx.Method[0].image);
    }

    // TODO: none unique elements should probably, be shown as warnings
    //       in a post parsing validation step instead of being transparently ignored
    return _.uniq(el);
  }

  exclusion(ctx) {
    const exList = ctx.NAME.map(nameToken => nameToken.image, this);
    return exList;
  }

  paginationDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  serviceDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  microserviceDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  searchEngineDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  noClientDeclaration(ctx) {
    return extractListExcluded(ctx, this);
  }

  noServerDeclaration(ctx) {
    return extractListExcluded(ctx, this);
  }

  noFluentMethod(ctx) {
    return extractListExcluded(ctx, this);
  }

  filterDeclaration(ctx) {
    return extractListExcluded(ctx, this);
  }

  filterDef(ctx) {
    let el = [];
    if (ctx.NAME) {
      el = ctx.NAME.map(nameToken => nameToken.image, this);
    }

    if (ctx.ALL || ctx.STAR) {
      el.push('*');
    }

    // TODO: none unique elements should probably, be shown as warnings
    //       in a post parsing validation step instead of being transparently ignored
    return _.uniq(el);
  }

  clientRootFolderDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  angularSuffixDeclaration(ctx) {
    return extractNameListExcluded(ctx, this);
  }

  comment(ctx) {
    if (ctx.COMMENT) {
      return trimComment(ctx.COMMENT[0].image);
    }

    return null;
  }

  applicationDeclaration(ctx) {
    return this.visit(ctx.applicationSubDeclaration);
  }

  applicationSubDeclaration(ctx) {
    const appSubDec = {
      config: {},
      entities: { entityList: [], excluded: [] }
    };

    if (ctx.applicationSubConfig) {
      // Apparently the pegjs grammar only returned the last config
      const appConfigAst = this.visit(_.last(ctx.applicationSubConfig));
      appSubDec.config = appConfigAst;
    }

    if (ctx.applicationSubEntities) {
      // Apparently the pegjs grammar only returned the last entities
      const appEntitiesAst = this.visit(_.last(ctx.applicationSubEntities));
      appSubDec.entities = appEntitiesAst;
    }

    return appSubDec;
  }

  applicationSubConfig(ctx) {
    const config = {};

    if (ctx.applicationConfigDeclaration) {
      const configProps = ctx.applicationConfigDeclaration.map(
        this.visit,
        this
      );
      configProps.forEach((configProp) => {
        config[configProp.key] = configProp.value;

        if (configProp.key === 'packageName') {
          config.packageFolder = configProp.value.replace(/[.]/g, '/');
        }

        if (configProp.key === 'serviceDiscoveryType') {
          if (configProp.value === 'true') {
            config.serviceDiscoveryType = true;
          } else if (configProp.value === 'false') {
            config.serviceDiscoveryType = false;
          }
        }
      });
    }

    return config;
  }

  applicationSubEntities(ctx) {
    const result = extractListExcluded(ctx, this, 'entityList');
    if (result.excluded === undefined) {
      result.excluded = [];
    }
    return result;
  }

  applicationConfigDeclaration(ctx) {
    let key = ctx.CONFIG_KEY[0].image;

    // https://github.com/jhipster/jhipster-core/issues/184#issuecomment-370972666
    if (key === 'frontEndBuilder') {
      key = 'frontendBuilder';
    }
    const value = this.visit(ctx.configValue);

    return { key, value };
  }

  configValue(ctx) {
    if (ctx.qualifiedName) {
      return this.visit(ctx.qualifiedName);
    } else if (ctx.list) {
      return this.visit(ctx.list);
    } else if (ctx.INTEGER) {
      return parseInt(ctx.INTEGER[0].image, 10);
    } else if (ctx.STRING) {
      const stringImage = ctx.STRING[0].image;
      return stringImage.substring(1, stringImage.length - 1);
    } else if (ctx.BOOLEAN) {
      return ctx.BOOLEAN[0].image === 'true';
    }

    throw new Error('Non-Exhaustive Match');
  }

  qualifiedName(ctx) {
    const nameParts = ctx.NAME.map(namePart => namePart.image, this);
    return nameParts.join('.');
  }

  list(ctx) {
    const items = ctx.NAME.map(namePart => namePart.image, this);
    return items;
  }
}

function extractNameListExcluded(ctx, visitor) {
  const entityList = visitor.visit(ctx.entityList);
  const last = _.last(entityList);
  const allButFirst = _.dropRight(entityList);

  let exclusion;
  if (ctx.exclusion) {
    exclusion = visitor.visit(ctx.exclusion);
  }

  return { name: last, list: allButFirst, excluded: exclusion };
}

function extractListExcluded(ctx, visitor, listPropName) {
  if (!listPropName) {
    listPropName = 'list';
  }

  const entityList = visitor.visit(ctx.filterDef);

  let exclusion;
  if (ctx.exclusion) {
    exclusion = visitor.visit(ctx.exclusion);
  }

  const result = { excluded: exclusion };
  result[listPropName] = entityList;
  return result;
}

function trimComment(str) {
  return str.replace(/^\/[*]+/, '').replace(/[*]+\/$/, '');
}

const astBuilderVisitor = new JDLAstBuilderVisitor();

function buildAst(cst) {
  return astBuilderVisitor.visit(cst);
}
