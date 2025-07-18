export default function transformer(file, api) {
  const j = api.jscodeshift;

  const root = j(file.source);

  // Store class paths, used to push methods after class creation
  let classPaths = {};

  function createMethodDefinition(j, kind, key, path, isStatic = false) {
    return j.methodDefinition(
      kind,
      key,
      j.functionExpression(null, path.params, path.body),
      isStatic
    );
  }

  // First, collect all function names that have prototype manipulations
  const functionsWithPrototype = new Set();

  // Find functions that have prototype property assignments
  root
    .find(j.MemberExpression, {
      property: {
        name: "prototype",
      },
    })
    .forEach((path) => {
      if (path.value.object && path.value.object.name) {
        functionsWithPrototype.add(path.value.object.name);
      }
    });

  // Find functions that have static method assignments
  root
    .find(j.AssignmentExpression, {
      left: {
        type: "MemberExpression",
        property: {
          type: "Identifier",
        },
      },
      right: {
        type: "FunctionExpression",
      },
    })
    .forEach((path) => {
      if (path.value.left.object && path.value.left.object.name) {
        functionsWithPrototype.add(path.value.left.object.name);
      }
    });

  // Find functions that have Object.defineProperty calls
  root
    .find(j.CallExpression, {
      callee: {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "Object",
        },
        property: {
          type: "Identifier",
          name: "defineProperty",
        },
      },
    })
    .forEach((path) => {
      if (
        path.value.arguments[0] &&
        path.value.arguments[0].object &&
        path.value.arguments[0].object.name
      ) {
        functionsWithPrototype.add(path.value.arguments[0].object.name);
      }
    });

  /*
    Transform to create Class - Convert functions that start with uppercase letter
  */
  root
    .find(j.FunctionDeclaration, {
      id: {
        type: "Identifier",
      },
    })
    .filter((path) => {
      const functionName = path.value.id.name;
      // Convert functions that start with uppercase letter
      return functionName && functionName[0] === functionName[0].toUpperCase();
    })
    .forEach((path) => {
      // Capture any existing comments from the function
      const functionComments = path.value.comments || [];

      const classDeclaration = j.classDeclaration(
        path.value.id,
        j.classBody([
          createMethodDefinition(
            j,
            "method",
            j.identifier("constructor"),
            path.value
          ),
        ])
        // 3rd param => superClass support
      );

      // Preserve comments on the class declaration
      if (functionComments.length > 0) {
        classDeclaration.comments = functionComments;
      }

      j(path).replaceWith(classDeclaration);

      // Store path for future ref to insert methods
      classPaths[path.value.id.name] = path;
    });

  /*
    Transform prototype variables into class constructor
  */
  root
    .find(j.ExpressionStatement, {
      expression: {
        left: {
          type: "MemberExpression",
          object: {
            property: {
              name: "prototype",
            },
          },
        },
        right: {
          type: "Literal",
        },
      },
    })
    .forEach((path) => {
      const { name: className } = path.value.expression.left.object.object;
      const { name: memberName } = path.value.expression.left.property;
      const { value: memberValue } = path.value.expression.right;
      // Fetch previously stored class path to find constructor
      const classPath = classPaths[className];
      j(classPath)
        .find(j.MethodDefinition, {
          key: {
            type: "Identifier",
            name: "constructor",
          },
        })
        .forEach((path) => {
          const { body: constructorBody } = path.value.value.body;
          constructorBody.push(
            j.expressionStatement(
              j.assignmentExpression(
                "=",
                j.memberExpression(
                  j.thisExpression(),
                  j.identifier(memberName)
                ),
                j.literal(memberValue)
              )
            )
          );
        });
      j(path).remove();
    });

  /*
    Adds/pushes method/function at a given path to class
  */
  function addMethodToClass(path, isStatic) {
    const { name: className } = isStatic
      ? path.value.left.object
      : path.value.left.object.object;
    // Fetch previously stored class path to insert methods
    const classPath = classPaths[className];
    const { property: methodName } = path.value.left;
    console.log(
      `Adding method ${methodName.name} to class ${className} at ${path}`
    );
    if (!classPath) {
      console.warn(
        `Class ${className} not found for method ${methodName.name}`
      );
      return;
    }
    const { body: classBody } = classPath.value.body;
    classBody.push(
      createMethodDefinition(
        j,
        "method",
        methodName,
        path.value.right,
        isStatic ? true : false
      )
    );
    j(path).remove();
  }

  /*
    Transform to create class methods based on "prototype"
  */
  root
    .find(j.AssignmentExpression, {
      left: {
        type: "MemberExpression",
        object: {
          property: {
            name: "prototype",
          },
        },
      },
      right: {
        type: "FunctionExpression",
      },
    })
    .forEach((path) => addMethodToClass(path, false));

  /*
    Transform to create "static" class methods
  */
  root
    .find(j.AssignmentExpression, {
      left: {
        type: "MemberExpression",
        property: {
          type: "Identifier",
        },
      },
      right: {
        type: "FunctionExpression",
      },
    })
    .filter((path) => {
      // filter out exports
      // e.g. exports.foo = function() {}
      if (path.value.left.object && path.value.left.object.name === "exports") {
        return false;
      }
      return true;
    })
    .forEach((path) => addMethodToClass(path, true));

  /*
    Transform for getters, setters
  */
  root
    .find(j.CallExpression, {
      callee: {
        type: "MemberExpression",
        object: {
          type: "Identifier",
          name: "Object",
        },
        property: {
          type: "Identifier",
          name: "defineProperty",
        },
      },
    })
    .forEach((path) => {
      const { name: className } = path.value.arguments[0].object;
      // Fetch previously stored class path to insert methods
      const classPath = classPaths[className];
      const { body: classBody } = classPath.value.body;
      const { value: methodName } = path.value.arguments[1];
      const { properties } = path.value.arguments[2];

      properties.forEach((property) => {
        // Type of method => (get || set)
        const { name: type } = property.key;
        classBody.push(
          createMethodDefinition(
            j,
            type,
            j.identifier(methodName),
            property.value
          )
        );
      });

      j(path).remove();
    });

  return root.toSource();
}
