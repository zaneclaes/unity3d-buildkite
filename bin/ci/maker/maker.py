#!/usr/bin/env python3
import os, pkgutil, importlib, inspect, logging, subprocess

class Maker():
    # Assign all keyword arguments as properties on self, and keep the kwargs for later.
    def __init__(self, **kwargs):
        self._kwargs = kwargs
        for (k, v) in kwargs.items():
            setattr(self, k, v)
        ms = inspect.getmembers(self, predicate=inspect.ismethod)
        self.methods = dict([(n, m) for (n, m) in ms if not n.startswith('_')])
        self.log = logging.getLogger(self.__class__.__name__)

    # Add the names of the methods to a parser object.
    def _parse_args(self, parser, method_name):
        return parser

    # Instantiate one of each of the subclasses of this class.
    def _load_subclasses(self):
        module_dir = os.path.dirname(__file__)
        module_name = os.path.basename(os.path.normpath(module_dir))
        parent_class = self.__class__
        modules = {}
        # Load all the modules it the package:
        for (module_loader, name, ispkg) in pkgutil.iter_modules([module_dir]):
            modules[name] = importlib.import_module('.' + name, module_name)

        # Instantiate one of each class, passing the keyword arguments.
        ret = {}
        for cls in parent_class.__subclasses__():
            path = cls.__module__.split('.')
            ret[path[-1]] = cls(**self._kwargs)
        return ret

    def _exe(self, cmd):
        res = subprocess.run(cmd, shell=True, check=False, capture_output=True, text=True)
        if res.returncode == 0:
            ret = res.stdout.strip()
            return ret if ret else True
        msg = res.stderr.strip()
        if len(msg) <= 0: msg = res.stdout.strip()
        self.log.error(msg)
        return False
